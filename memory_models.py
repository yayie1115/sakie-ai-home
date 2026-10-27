"""Reference-only memory model selections and a loopback credential broker.

Provider credentials remain solely in Morrow's providers table. New browser
APIs return identifiers/status only; no provider key is copied to Serein.
"""
from datetime import datetime, timezone
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import threading
import time
from urllib.parse import urlsplit

import requests
from flask import jsonify, request

KEY = 'memory_model_routes_v1'
ROLES = ('embedding', 'reranker')
LOCK = threading.Lock()
DAILY_CALLS = 128
DAILY_CHARACTERS = 20000


class ModelError(ValueError):
    pass


def load(db):
    row = db.execute('SELECT value FROM settings WHERE key=?', (KEY,)).fetchone()
    return json.loads(row[0]) if row else {'revision': 0, 'embedding': None, 'reranker': None, 'validation': {}}


def store(db, value):
    db.execute('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
               (KEY, json.dumps(value, ensure_ascii=False)))


def resolve(db, selection):
    if not isinstance(selection, dict) or set(selection) != {'provider_id', 'model_id'}:
        raise ModelError('请选择已保存的提供方和模型')
    if type(selection['provider_id']) is not int or not isinstance(selection['model_id'], str):
        raise ModelError('提供方或模型格式无效')
    row = db.execute('SELECT id,name,api_url,api_key,format,models FROM providers WHERE id=?',
                     (selection['provider_id'],)).fetchone()
    if not row or row['format'] != 'openai' or not row['api_key']:
        raise ModelError('记忆模型需要已保存的 OpenAI 兼容连接')
    names = {item['id'] for item in json.loads(row['models'] or '[]')}
    if selection['model_id'] not in names:
        raise ModelError('模型不在该提供方已保存的列表中')
    url = urlsplit(row['api_url'])
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ModelError('记忆提供方必须使用无认证信息的 HTTPS API 地址')
    base = row['api_url'].rstrip('/')
    if url.hostname == 'api.siliconflow.cn' and not url.path.rstrip('/'):
        base += '/v1'
    signature = hashlib.sha256(json.dumps([row['id'], base, row['format'], selection['model_id'],
        hashlib.sha256(row['api_key'].encode()).hexdigest()]).encode()).hexdigest()
    return row, base, signature


def valid(db, state, role):
    try:
        _, _, signature = resolve(db, state.get(role))
        record = state.get('validation', {}).get(role, {})
        return record.get('status') == 'verified' and record.get('signature') == signature
    except (ValueError, KeyError, TypeError):
        return False


def public_state(db):
    state = load(db)
    choices = []
    for row in db.execute('SELECT id,name,models,format FROM providers ORDER BY sort_order,id'):
        if row['format'] == 'openai':
            choices.append({'provider_id': row['id'], 'name': row['name'],
                            'models': [{'id': m['id'], 'name': m.get('name') or m['id']}
                                       for m in json.loads(row['models'] or '[]')]})
    status = {}
    for role in ROLES:
        saved = state.get('validation', {}).get(role, {})
        status[role] = {'status': 'verified' if valid(db, state, role) else
            ('pending' if saved.get('status') == 'verified' else saved.get('status', 'pending')),
            'dimension': saved.get('dimension'), 'checked_at': saved.get('checked_at')}
    key = 'memory_model_budget_' + datetime.now(timezone.utc).date().isoformat()
    counter = db.execute('SELECT value FROM settings WHERE key=?', (key,)).fetchone()
    used = json.loads(counter[0]) if counter else {'calls':0,'characters':0}
    hook_enabled = False
    try:
        path = os.environ.get('MORROW_SEREIN_CONFIG')
        config = json.loads(Path(path).read_text()) if path else {}
        hook_enabled = bool(config.get('enabled') and config.get('hook_ready'))
    except (OSError, ValueError):
        pass
    return {**{k: state.get(k) for k in ('revision', *ROLES)}, 'validation': status,
            'budget':{**used,'call_limit':DAILY_CALLS,'character_limit':DAILY_CHARACTERS},
            'hook_enabled':hook_enabled, 'source_sync_enabled':False,
            'providers': choices, 'models_ready': all(valid(db, state, role) for role in ROLES),
            'note': '模型接口验证不等于完整 Hook 已启用；原话同步及自动 Event 另有安全门槛。'}


def disable_hook():
    path = os.environ.get('MORROW_SEREIN_CONFIG')
    if not path:
        return
    target = Path(path)
    value = json.loads(target.read_text())
    value['hook_ready'] = False
    pending = target.with_name(target.name + '.pending')
    with pending.open('w', encoding='utf-8') as out:
        os.chmod(pending, 0o600)
        json.dump(value, out); out.flush(); os.fsync(out.fileno())
    pending.replace(target)


def reserve(db, characters):
    day = datetime.now(timezone.utc).date().isoformat()
    key = 'memory_model_budget_' + day
    db.execute('BEGIN IMMEDIATE')
    row = db.execute('SELECT value FROM settings WHERE key=?', (key,)).fetchone()
    used = json.loads(row[0]) if row else {'calls': 0, 'characters': 0}
    if used['calls'] >= DAILY_CALLS or used['characters'] + characters > DAILY_CHARACTERS:
        db.rollback()
        raise ModelError('已到记忆模型日预算上限，停止请求')
    used['calls'] += 1; used['characters'] += characters
    db.execute('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
               (key, json.dumps(used)))
    db.commit()


def provider_request(db, role, payload):
    selection = load(db).get(role)
    row, base, _ = resolve(db, selection)
    model = selection['model_id']
    if payload.get('model') != model:
        raise ModelError('模型与当前记忆设置不一致')
    if role == 'embedding':
        inputs = payload.get('input')
        inputs = [inputs] if isinstance(inputs, str) else inputs
        if not isinstance(inputs, list) or not 1 <= len(inputs) <= 16 or any(not isinstance(t, str) or not t for t in inputs):
            raise ModelError('向量请求需要1–16段非空文本')
        texts = inputs
        body = {'model': model, 'input': inputs, 'encoding_format': 'float'}
        endpoint = '/embeddings'
    else:
        docs, query = payload.get('documents'), payload.get('query')
        if not isinstance(query, str) or not isinstance(docs, list) or not 1 <= len(docs) <= 16 or any(not isinstance(t, str) or not t for t in docs):
            raise ModelError('重排请求需要查询和1–16段文本')
        texts = [query, *docs]
        body = {'model': model, 'query': query, 'documents': docs, 'top_n': len(docs), 'return_documents': False}
        endpoint = '/rerank'
    characters = sum(map(len, texts))
    if characters > 12000:
        raise ModelError('记忆请求超过单次字符预算')
    reserve(db, characters)
    session = requests.Session(); session.trust_env = False
    try:
        result = session.post(base + endpoint, headers={'Authorization': 'Bearer ' + row['api_key']},
                              json=body, timeout=(3, 8), allow_redirects=False)
        if result.status_code != 200:
            raise ModelError('模型接口不兼容或不可用（HTTP %d）' % result.status_code)
        data = result.json()
        if not isinstance(data, dict) or (data.get('model') is not None and data['model'] != model):
            raise ModelError('提供方返回了不同模型')
        if role == 'embedding':
            if data.get('model') != model:
                raise ModelError('向量响应缺少匹配的模型标识')
            vectors = data.get('data', [])
            if len(vectors) != len(inputs):
                raise ModelError('向量返回数量错误')
            dimension = None; seen = set(); clean = []
            for item in vectors:
                vector = item.get('embedding'); index = item.get('index')
                if (not isinstance(vector, list) or not vector or len(vector) > 8192
                        or any(type(n) not in (int, float) or not math.isfinite(n) for n in vector)
                        or not any(n != 0 for n in vector)
                        or type(index) is not int or not 0 <= index < len(inputs) or index in seen):
                    raise ModelError('向量结构无效')
                if dimension is not None and dimension != len(vector):
                    raise ModelError('向量维度不一致')
                dimension = len(vector); seen.add(index); clean.append({'index': index, 'embedding': vector, 'object': 'embedding'})
            return {'model': model, 'object': 'list', 'data': clean,
                    'usage': {k: int(v) for k, v in data.get('usage', {}).items()
                              if k in ('prompt_tokens', 'total_tokens') and type(v) is int}}
        results = data.get('results')
        if not isinstance(results, list) or len(results) != len(docs):
            raise ModelError('重排序响应结构无效')
        seen = set(); clean = []
        for item in results:
            index, score = item.get('index'), item.get('relevance_score')
            if type(index) is not int or not 0 <= index < len(docs) or index in seen or type(score) not in (float, int) or not math.isfinite(score) or not 0 <= score <= 1:
                raise ModelError('重排序分数或索引无效')
            seen.add(index); clean.append({'index': index, 'relevance_score': score})
        return {'model': model, 'results': clean}
    except (requests.RequestException, ValueError, TypeError, KeyError) as error:
        if isinstance(error, ModelError):
            raise
        raise ModelError('记忆模型连接失败或响应无效') from None
    finally:
        session.close()


def register(app, get_db, require_auth, *, broker_secret=None):
    def same_origin():
        origin = request.headers.get('Origin')
        scheme = request.scheme
        if request.remote_addr in ('127.0.0.1', '::1'):
            scheme = request.headers.get('X-Forwarded-Proto', scheme).split(',')[0].strip()
        parsed = urlsplit(origin) if origin else None
        return request.is_json and (not parsed or (parsed.netloc.casefold() == request.host.casefold()
               and parsed.scheme == scheme and not parsed.username and not parsed.password))

    def broker_authorized():
        if request.remote_addr not in ('127.0.0.1', '::1'):
            return False
        try:
            if broker_secret is not None:
                return hmac.compare_digest(request.headers.get('Authorization', ''), 'Bearer ' + broker_secret)
            import serein_bridge
            bridge = serein_bridge.configured()
            return bridge and hmac.compare_digest(request.headers.get('Authorization', ''), 'Bearer ' + bridge.token)
        except Exception:
            return False

    @app.get('/api/memory/models')
    @require_auth
    def memory_model_status():
        return jsonify(public_state(get_db()))

    @app.put('/api/memory/models')
    @require_auth
    def memory_model_save():
        if not same_origin():
            return jsonify(error='仅允许同源JSON请求'), 403
        value = request.get_json() or {}
        if not isinstance(value, dict):
            return jsonify(error='需要JSON对象'), 400
        db = get_db(); current = load(db)
        if type(value.get('revision')) is not int or value.get('revision') != current['revision']:
            return jsonify(error='设置已变化，请刷新后重试'), 409
        if set(value) - {'revision', *ROLES}:
            return jsonify(error='不接受密钥或其他配置字段'), 400
        try:
            for role in ROLES:
                selection = value.get(role)
                if selection is not None:
                    resolve(db, selection)
            if all(current.get(role) == value.get(role) for role in ROLES):
                return jsonify(public_state(db))
            disable_hook()
            db.execute('BEGIN IMMEDIATE')
            if load(db)['revision'] != current['revision']:
                db.rollback(); return jsonify(error='设置冲突'), 409
            next_value = {'revision': current['revision'] + 1, **{role: value.get(role) for role in ROLES}, 'validation': {}}
            store(db, next_value); db.commit()
            return jsonify(public_state(db))
        except (ValueError, OSError):
            db.rollback(); return jsonify(error='无法保存，请检查提供方和模型选择'), 400

    @app.post('/api/memory/models/validate')
    @require_auth
    def memory_model_validate():
        if not same_origin():
            return jsonify(error='仅允许同源JSON请求'), 403
        value = request.get_json() or {}
        if not isinstance(value, dict):
            return jsonify(error='需要JSON对象'), 400
        role = value.get('role')
        if role not in ROLES:
            return jsonify(error='请选择向量或重排序模型'), 400
        if not LOCK.acquire(blocking=False):
            return jsonify(error='正在验证，请稍后'), 409
        try:
            db = get_db(); state = load(db); selection = state.get(role)
            _, _, signature = resolve(db, selection)
            old = state.get('validation', {}).get(role, {})
            if time.time() - old.get('attempted_at', 0) < 60:
                return jsonify(error='请在60秒后重试验证'), 429
            state.setdefault('validation', {})[role] = {'attempted_at': time.time(), 'status': 'pending'}
            store(db, state); db.commit()
            payload = {'model': selection['model_id']}
            payload.update({'input': ['虚构：蓝色纸船。']} if role == 'embedding' else
                           {'query': '虚构纸船', 'documents': ['蓝色纸船。', '红色山峰。']})
            try:
                result = provider_request(db, role, payload)
                record = {'status': 'verified', 'signature': signature,
                          'dimension': len(result['data'][0]['embedding']) if role == 'embedding' else None}
            except ModelError:
                record = {'status': 'incompatible_or_unavailable'}
            db.execute('BEGIN IMMEDIATE'); latest = load(db)
            if latest['revision'] != state['revision'] or resolve(db, selection)[2] != signature:
                db.rollback(); return jsonify(error='配置已变化，验证结果未应用'), 409
            latest['validation'][role] = {**record, 'attempted_at': time.time(),
                                        'checked_at': datetime.now(timezone.utc).isoformat()}
            store(db, latest); db.commit()
            return jsonify(public_state(db))
        except (ValueError, TypeError):
            return jsonify(error='请先保存该记忆模型'), 400
        finally:
            LOCK.release()

    @app.get('/internal/memory-models/config')
    def memory_broker_config():
        if not broker_authorized():
            return jsonify(error='unauthorized'), 401
        db = get_db(); state = load(db)
        def generation(role):
            try:
                row, base, _ = resolve(db, state.get(role))
                return hashlib.sha256(json.dumps([row['id'],base,row['format'],state[role]['model_id']]).encode()).hexdigest()[:16]
            except ValueError:
                return ''
        return jsonify(revision=state['revision'], **{role: {'selection': state.get(role), 'generation': generation(role),
            'verified': valid(db, state, role), 'dimension': state.get('validation', {}).get(role, {}).get('dimension')}
            for role in ROLES})

    @app.post('/internal/memory-models/<operation>')
    def memory_model_relay(operation):
        if not broker_authorized():
            return jsonify(error='unauthorized'), 401
        role = {'embeddings': 'embedding', 'rerank': 'reranker'}.get(operation)
        if role is None or not request.is_json or request.content_length is None or request.content_length > 131072:
            return jsonify(error='unsupported_request'), 400
        db = get_db()
        if not valid(db, load(db), role):
            return jsonify(error='memory_model_not_validated'), 409
        value = request.get_json() or {}
        if not isinstance(value, dict):
            return jsonify(error='unsupported_request'), 400
        try:
            return jsonify(provider_request(db, role, value))
        except ModelError:
            return jsonify(error='memory_model_unavailable'), 502
