"""Bounded background semantic extraction into existing Serein Scenes.

The existing bridge ledger stores jobs/receipts, never a second recall store.
No history import, tool_calls dependency, Event processing or source override.
"""
from contextlib import closing
import json
import logging
from pathlib import Path
import re
import sqlite3
import threading
import time
import unicodedata

import requests
import serein_bridge

LOG=logging.getLogger(__name__)
_lock=threading.Lock()
_workers={}
PROMPT='''你是新聊天文本的长期记忆整理器，不扮演聊天角色。仅分析本次用户文本。
判断是否含明确自述的长期偏好、稳定个人信息、重要约定。普通寒暄、问题、假设、
引用他人的描述、暂时感受、不能确定归属的说法，不应保存。否定记忆要求必须遵守。
保留否定、时间变化和虚构标签。不能新增推测，不能把故事当用户现实经历。
只返回一个JSON对象，不要解释：
{"remember":false} 或
{"remember":true,"kind":"preference|profile|commitment","memory":"简洁、准确、保留变化与虚构标签的记忆",
"quote":"用户文本中连续、完全一致的证据摘录","cues":["检索关键词"]}。
quote必须是原文连续片段，memory不能超出quote所表达的事实。'''


def initialize(bridge):
    with bridge.ledger.connect() as db:
        db.executescript('''CREATE TABLE IF NOT EXISTS auto_text_jobs(
            id TEXT PRIMARY KEY,session_id INTEGER,message_id INTEGER,source_hash TEXT,
            provider_id INTEGER,model TEXT,state TEXT NOT NULL,attempts INTEGER DEFAULT 0,
            next_at REAL NOT NULL,candidate TEXT,memory_hash TEXT,scene_id TEXT,error TEXT DEFAULT '',
            enqueued_at REAL NOT NULL,finished_at REAL,enqueue_ms REAL DEFAULT 0,
            extraction_ms REAL DEFAULT 0,write_ms REAL DEFAULT 0,recall_wait_ms REAL DEFAULT 0);
            CREATE INDEX IF NOT EXISTS auto_text_ready ON auto_text_jobs(state,next_at);
            CREATE INDEX IF NOT EXISTS auto_text_duplicate ON auto_text_jobs(memory_hash,state);''')
        if 'recall_wait_ms' not in {row[1] for row in db.execute('PRAGMA table_info(auto_text_jobs)')}:
            db.execute('ALTER TABLE auto_text_jobs ADD COLUMN recall_wait_ms REAL DEFAULT 0')


def enabled(bridge):
    return bool(bridge and bridge.config.get('auto_text_memory_enabled') and bridge.config.get('tools_enabled')
                and not bridge.config.get('source_gateway_enabled') and not bridge.config.get('raw_sync_enabled'))


def source(path,sid,mid):
    with closing(sqlite3.connect(Path(path).resolve().as_uri()+'?mode=ro',uri=True)) as db:
        db.row_factory=sqlite3.Row
        control=db.execute('SELECT enabled,recall_blocked FROM memory_bridge_control WHERE id=1').fetchone()
        if not control or control['enabled'] or control['recall_blocked']:return None
        if db.execute("SELECT 1 FROM sqlite_master WHERE name='morrow_context_control'").fetchone():
            row=db.execute('SELECT enabled FROM morrow_context_control WHERE id=1').fetchone()
            if not row or row[0]:return None
        row=db.execute("SELECT content,active,attachments,hidden,created_at FROM messages WHERE id=? AND session_id=? AND role='user'",(mid,sid)).fetchone()
        if not row or row['hidden'] or json.loads(row['attachments'] or '[]'):return None
        value=dict(row);value['synthetic']=False
        if db.execute("SELECT 1 FROM sqlite_master WHERE name='sessions'").fetchone():
            session=db.execute('SELECT title FROM sessions WHERE id=?',(sid,)).fetchone()
            value['synthetic']=bool(session and str(session[0]).startswith('【虚构验收】'))
        value['hash']=serein_bridge.digest([sid,mid,value['active'],value['content'],value['synthetic']])
        return value


def validate(raw,text):
    if not isinstance(raw,str) or len(raw)>12000:raise ValueError('invalid_extraction_json')
    raw=raw.strip()
    if raw.startswith('```'):
        raw=re.sub(r'^```(?:json)?\s*|\s*```$','',raw)
    value=json.loads(raw)
    if not isinstance(value,dict) or type(value.get('remember')) is not bool:raise ValueError('invalid_extraction_shape')
    if not value['remember']:
        if set(value)!={'remember'}:raise ValueError('invalid_skip_shape')
        return None
    if set(value)!={'remember','kind','memory','quote','cues'}:raise ValueError('invalid_extraction_fields')
    if value['kind'] not in ('preference','profile','commitment'):raise ValueError('invalid_memory_kind')
    if not isinstance(value['quote'],str) or not value['quote'].strip() or len(value['quote'])>2000 or value['quote'] not in text:
        raise ValueError('quote_not_in_current_text')
    if not isinstance(value['memory'],str) or not 1<=len(value['memory'].strip())<=500:raise ValueError('invalid_memory_length')
    if not isinstance(value['cues'],list) or not 1<=len(value['cues'])<=6 or any(not isinstance(x,str) or not 1<=len(x.strip())<=60 for x in value['cues']):
        raise ValueError('invalid_memory_cues')
    # The host keeps the exact quote alongside the compact interpretation.
    # This is still an independent Scene, never certified original evidence.
    return value


def extract(path,job,text,timeout):
    import chat_engine
    provider=chat_engine.get_provider(job['provider_id'])
    if provider:
        base,key,fmt=provider['base_url'],provider['api_key'],provider['format']
    else:base,key,fmt=chat_engine.LLM_BASE_URL,chat_engine.LLM_API_KEY,'openai'
    if not key or not job['model']:raise ValueError('extraction_model_not_configured')
    with requests.Session() as client:
        client.trust_env=False
        if fmt=='openai':
            response=client.post(base.rstrip('/')+'/chat/completions',headers={'Authorization':'Bearer '+key},
                json={'model':job['model'],'messages':[{'role':'system','content':PROMPT},{'role':'user','content':text}],
                      'stream':False,'max_tokens':384,'temperature':0},timeout=(3,timeout),allow_redirects=False)
        elif fmt=='claude':
            response=client.post(base.rstrip('/')+'/messages',headers={'x-api-key':key,'anthropic-version':'2023-06-01'},
                json={'model':job['model'],'system':PROMPT,'messages':[{'role':'user','content':text}],
                      'max_tokens':384,'temperature':0},timeout=(3,timeout),allow_redirects=False)
        else:raise ValueError('unsupported_extraction_protocol')
        if response.status_code!=200:raise ValueError('extraction_http_'+str(response.status_code))
        if len(response.content)>65536:raise ValueError('extraction_response_too_large')
        data=response.json()
        if fmt=='openai':raw=data['choices'][0]['message']['content']
        else:raw=''.join(v.get('text','') for v in data.get('content',[]) if v.get('type')=='text')
    return validate(raw,text)


def enqueue(path,sid,mid,provider_id,model,*,bridge=None):
    started=time.perf_counter();bridge=bridge or serein_bridge.configured()
    if not enabled(bridge):return None
    row=source(path,sid,mid)
    if not row:return None
    text=row['content'].strip()
    if len(text)<3 or len(text)>4000:return None
    # Explicit requests already have a synchronous acknowledged path. Natural
    # content is never gated by positive keyword matching here.
    if serein_bridge.explicit_memory_request(text):return None
    initialize(bridge)
    identifier=serein_bridge.digest([bridge.config['instance_id'],sid,mid,row['hash']])
    with bridge.ledger.connect() as db:
        db.execute('INSERT OR IGNORE INTO auto_text_jobs(id,session_id,message_id,source_hash,provider_id,model,state,next_at,enqueued_at) VALUES(?,?,?,?,?,?,\'queued\',?,?)',
                   (identifier,sid,mid,row['hash'],provider_id,model,time.time()+1,time.time()))
        db.execute('UPDATE auto_text_jobs SET enqueue_ms=? WHERE id=?',((time.perf_counter()-started)*1000,identifier))
    return identifier


def run_one(path,bridge,*,extractor=extract,now=None):
    now=time.time() if now is None else now
    with bridge.ledger.connect() as db:
        db.execute('BEGIN IMMEDIATE')
        job=db.execute("SELECT * FROM auto_text_jobs WHERE state='queued' AND next_at<=? ORDER BY enqueued_at LIMIT 1",(now,)).fetchone()
        if not job:return False
        job=dict(job)
        db.execute("UPDATE auto_text_jobs SET state='classifying',attempts=attempts+1,error='' WHERE id=?",(job['id'],))
    def finish(state,error='',**fields):
        fields.update(state=state,error=error,finished_at=time.time())
        with bridge.ledger.connect() as db:
            db.execute('UPDATE auto_text_jobs SET '+','.join(k+'=?' for k in fields)+' WHERE id=?',(*fields.values(),job['id']))
    try:
        row=source(path,job['session_id'],job['message_id'])
        if not row or row['hash']!=job['source_hash']:finish('skipped','source_changed');return True
        if job['candidate']:candidate=json.loads(job['candidate'])
        else:
            started=time.perf_counter()
            candidate=extractor(path,job,row['content'],max(5,min(60,float(bridge.config.get('auto_text_timeout',40)))))
            elapsed=(time.perf_counter()-started)*1000
            if candidate is None:finish('skipped','not_long_term',extraction_ms=elapsed);return True
            # Validate injected/custom extractors too, not only HTTP responses.
            candidate=validate(json.dumps(candidate,ensure_ascii=False),row['content'])
            normalized=''.join(c for c in unicodedata.normalize('NFKC',candidate['quote']).casefold() if c.isalnum())
            stamp=serein_bridge.digest([candidate['kind'],normalized])
            with bridge.ledger.connect() as db:
                old=db.execute("SELECT scene_id FROM auto_text_jobs WHERE memory_hash=? AND state='succeeded' AND scene_id IS NOT NULL LIMIT 1",(stamp,)).fetchone()
            if old:
                finish('skipped','duplicate_memory',scene_id=old['scene_id'],memory_hash=stamp,extraction_ms=elapsed)
                return True
            with bridge.ledger.connect() as db:
                db.execute("UPDATE auto_text_jobs SET candidate=?,memory_hash=?,extraction_ms=?,state='writing' WHERE id=?",
                           (json.dumps(candidate,ensure_ascii=False),stamp,elapsed,job['id']))
        current=source(path,job['session_id'],job['message_id'])
        if not current or current['hash']!=job['source_hash']:finish('skipped','source_changed');return True
        args={'title':{'preference':'自动记忆 · 偏好','profile':'自动记忆 · 个人信息','commitment':'自动记忆 · 约定'}[candidate['kind']],
              'content':('【虚构验收资料，不代表真实用户偏好】\n' if row['synthetic'] else '')+
                        '用户于 '+row['created_at']+' 表达：'+candidate['memory']+'\n用户原句摘录：'+candidate['quote']+
                        '\n这是当时的自述记录；保留既有记录，不自动覆盖其他时期的表达。',
              'cues':candidate['cues'],'date':row['created_at'][:10]}
        started=time.perf_counter()
        result=bridge.execute('serein_write_scene',args,bridge.config['instance_id']+':'+str(job['session_id']),'auto-text:'+job['id'])
        elapsed=(time.perf_counter()-started)*1000
        if not result['ok']:finish('unknown','scene_write_not_confirmed',write_ms=elapsed);return True
        matched=re.search(r'\[scene_id:([^\]]+)\]',result['content'])
        if not matched:finish('unknown','scene_receipt_missing',write_ms=elapsed);return True
        current=source(path,job['session_id'],job['message_id'])
        if not current or current['hash']!=job['source_hash']:
            finish('unknown','source_changed_after_write',scene_id=matched.group(1),write_ms=elapsed);return True
        finish('succeeded',scene_id=matched.group(1),candidate=None,write_ms=elapsed)
    except Exception as exc:
        # Never publish provider bodies/credentials/chat text in diagnostics.
        error=str(exc) if isinstance(exc,ValueError) and re.fullmatch(r'[a-z_0-9]+',str(exc)) else type(exc).__name__
        if job['attempts']<1 and not job['candidate']:
            with bridge.ledger.connect() as db:
                db.execute("UPDATE auto_text_jobs SET state='queued',error=?,next_at=? WHERE id=?",(error,time.time()+60,job['id']))
        else:finish('failed',error)
        LOG.warning('Automatic text memory job failed: %s',error)
    return True


def start(path):
    bridge=serein_bridge.configured()
    if not enabled(bridge):return
    key=bridge.ledger.path
    with _lock:
        if key in _workers and _workers[key][1].is_alive():_workers[key][0].set();return
        signal=threading.Event()
        def loop():
            import memory_outbox
            while True:
                with memory_outbox.delivery_lock(key) as acquired:
                    if acquired:
                        initialize(bridge)
                        with bridge.ledger.connect() as db:
                            db.execute("UPDATE auto_text_jobs SET state='queued' WHERE state IN ('classifying','writing')")
                        while True:
                            try:
                                current=serein_bridge.configured()
                                if not enabled(current) or current.ledger.path!=key:return
                                if not run_one(path,current):
                                    with current.ledger.connect() as db:
                                        due=db.execute("SELECT min(next_at) FROM auto_text_jobs WHERE state='queued'").fetchone()[0]
                                    delay=30 if due is None else max(.05,min(30,due-time.time()))
                                    signal.wait(delay);signal.clear()
                            except Exception:
                                LOG.warning('Automatic text memory worker paused; chat remains available')
                                signal.wait(5);signal.clear()
                signal.wait(2);signal.clear()
        thread=threading.Thread(target=loop,daemon=True,name='morrow-auto-text-memory')
        _workers[key]=(signal,thread);thread.start()


def wait_for_recent_other_session(path,bridge,sid,mid):
    """Bounded visibility grace ONLY on entry into a new conversation.

    Ordinary turns do not await extraction. If a user immediately opens another
    chat while the preceding one is still being saved, avoid an avoidable miss.
    A slow/broken extractor never holds the chat past the configured bound.
    """
    if not enabled(bridge):return 0
    with closing(sqlite3.connect(Path(path).resolve().as_uri()+'?mode=ro',uri=True)) as db:
        if db.execute("SELECT count(*) FROM messages WHERE session_id=? AND role='user'",(sid,)).fetchone()[0]>1:return 0
    initialize(bridge)
    started=time.perf_counter();deadline=time.monotonic()+max(0,min(8,float(bridge.config.get('auto_text_recall_wait',8))))
    while True:
        with bridge.ledger.connect() as db:
            pending=db.execute("SELECT 1 FROM auto_text_jobs WHERE session_id!=? AND enqueued_at>? AND state IN ('queued','classifying','writing') LIMIT 1",
                               (sid,time.time()-120)).fetchone()
        if not pending or time.monotonic()>=deadline:break
        time.sleep(.1)
    elapsed=(time.perf_counter()-started)*1000
    with bridge.ledger.connect() as db:
        db.execute('UPDATE auto_text_jobs SET recall_wait_ms=? WHERE session_id=? AND message_id=?',(elapsed,sid,mid))
    return elapsed


def status(bridge):
    if not enabled(bridge):return {'enabled':False,'counts':{},'recent':[]}
    initialize(bridge)
    with bridge.ledger.connect() as db:
        counts=dict(db.execute('SELECT state,count(*) FROM auto_text_jobs GROUP BY state').fetchall())
        rows=[dict(r) for r in db.execute('''SELECT id,session_id,message_id,state,attempts,error,scene_id,
            enqueued_at,finished_at,enqueue_ms,extraction_ms,write_ms,recall_wait_ms FROM auto_text_jobs ORDER BY enqueued_at DESC LIMIT 20''')]
    worker=_workers.get(bridge.ledger.path)
    return {'enabled':True,'worker_running':bool(worker and worker[1].is_alive()),'counts':counts,'recent':rows}
