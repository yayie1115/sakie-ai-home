"""Opt-in real loopback transport exercise against a NEW synthetic instance.

Run with the Morrow interpreter; --python selects the pinned Serein venv.
Never accepts an existing database, credential, origin or instance directory.
"""
import argparse
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import requests
import serein_bridge


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--python', required=True)
    args = parser.parse_args()
    checks = []
    with tempfile.TemporaryDirectory(prefix='serein-synthetic-transport-') as work:
        root = Path(work); os.chmod(root, 0o700)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
        origin = f'http://127.0.0.1:{port}'
        token = root / 'token'; token.write_text('synthetic-transport-token-only'); os.chmod(token, 0o600)
        config = root / 'config.toml'
        config.write_text(f'[storage]\ndatabase="{root}/memory.db"\nindex="{root}/index.db"\n'
            '[runtime]\nwritable=true\n[mcp]\ntools=["read_memory","recall_memory","write_scene","edit_scene","set_scene_status"]\n')
        headers = {'Authorization': 'Bearer synthetic-transport-token-only'}
        output = open(root / 'server.log', 'w')
        process = None

        def start():
            env = {**os.environ, 'SEREIN_HTTP_TOKEN_FILE': str(token), 'PYTHONDONTWRITEBYTECODE': '1'}
            child = subprocess.Popen([args.python, '-m', 'serein.launch', '--config', str(config),
                'http', '--live', '--host', '127.0.0.1', '--port', str(port)], env=env,
                stdout=output, stderr=output)
            for _ in range(120):
                if child.poll() is not None:
                    raise RuntimeError('Synthetic Serein failed to start')
                try:
                    if requests.get(origin + '/health', timeout=.3).status_code == 200:
                        return child
                except requests.RequestException:
                    pass
                time.sleep(.1)
            child.terminate(); child.wait(timeout=15)
            raise RuntimeError('Synthetic startup timed out')

        try:
            process = start()
            assert requests.get(origin + '/v1/capabilities', timeout=5).status_code == 401
            checks.append('authentication_boundary')
            client = serein_bridge.Bridge({'base_url': origin, 'token_file': str(token),
                'ledger': str(root / 'bridge.db'), 'tools_enabled': True,
                'hook_enabled': True, 'hook_ready': True})
            names = {d['function']['name'] for d in client.definitions()}
            assert 'serein_write_scene' in names and 'serein_pipeline_next' not in names
            checks.append('restricted_mcp_discovery')
            saved = client.execute('serein_write_scene', {'title': 'Synthetic observatory',
                'content': 'A fictional telescope visit was planned for Saturday.',
                'cues': ['fictional telescope'], 'date': '2026-01-01'}, 'synthetic-window', 'turn-1')
            assert saved['ok'], saved['error']
            identifier = re.search(r'\[scene_id:([^\]]+)\]', saved['content'])[1]
            read = client.execute('serein_read_memory', {'identifier': identifier}, 'synthetic-window', 'turn-2')
            assert read['ok'] and 'fictional telescope' in read['content']
            checks.append('scene_write_and_read')
            stamp = re.search(r'^updated_at: (.+)$', read['content'], re.M)[1]
            edit = client.execute('serein_edit_scene', {'scene_id': identifier, 'expected_updated_at': stamp,
                'content': 'The fictional telescope visit was changed to Sunday.'}, 'synthetic-window', 'turn-3')
            assert edit['ok'], edit['error']
            read = client.execute('serein_read_memory', {'identifier': identifier}, 'synthetic-window', 'turn-4')
            assert 'Sunday' in read['content']
            checks.append('scene_revision')
            # No real embedding API is used: missing semantic setup must fail open.
            assert client.prepare('synthetic-window', 'receipt-1', 'fictional telescope')['context'] == ''
            checks.append('unconfigured_hook_fails_open')
            body = {'source': 'synthetic-only', 'events': [{'source_event_id': 'message-1:v1',
                'session_id': 'synthetic-window', 'role': 'user', 'text': 'A fictional plan.',
                'created_at': '2026-01-01T00:00:00Z'}]}
            first = requests.post(origin + '/api/ingest-raw', headers=headers, json=body, timeout=5).json()
            again = requests.post(origin + '/api/ingest-raw', headers=headers, json=body, timeout=5).json()
            assert first['inserted'] == 1 and again['duplicate'] == 1
            checks.append('raw_archive_and_duplicate')
            client.ledger.enqueue('message-1:v1', body)
            try:
                client.ledger.enqueue('message-1:v1', {'text': 'conflicting fictional content'})
                raise AssertionError('conflict was accepted')
            except serein_bridge.Conflict:
                checks.append('host_conflict_guard')
            assert client.archive_event(body['events'][0] | {'source': body['source']}) == 'already_archived'
            try:
                client.archive_event(body['events'][0] | {'source': body['source'], 'text': 'different fictional text'})
                raise AssertionError('remote conflict was accepted')
            except serein_bridge.Conflict:
                checks.append('remote_conflict_detected_before_ingest')
            process.terminate(); process.wait(timeout=20); process = start()
            read = client.execute('serein_read_memory', {'identifier': identifier}, 'synthetic-window', 'turn-5')
            assert read['ok'] and 'Sunday' in read['content']
            checks.append('server_restart_persistence')
            stamp = re.search(r'^updated_at: (.+)$', read['content'], re.M)[1]
            deleted = client.execute('serein_set_scene_status', {'scene_id': identifier,
                'expected_updated_at': stamp, 'status': 'deleted'}, 'synthetic-window', 'turn-6')
            assert deleted['ok'], deleted['error']
            read = client.execute('serein_read_memory', {'identifier': identifier}, 'synthetic-window', 'turn-7')
            assert 'Sunday' not in read['content'] and 'deleted' in read['content']
            checks.append('scene_soft_delete_hides_body')
            assert not serein_bridge.SOURCE_RETRACTION_VERIFIED
            checks.append('real_source_sync_hard_disabled')
            process.terminate(); process.wait(timeout=20); process = None
            client._retry_after = 0
            assert client.prepare('synthetic-window', 'receipt-2', 'fictional plan')['context'] == ''
            checks.append('service_outage_fails_open')
        finally:
            if process and process.poll() is None:
                process.terminate(); process.wait(timeout=20)
            output.close()
    print(json.dumps({'passed': len(checks), 'checks': checks,
        'not_verified': ['real_semantic_models', 'real_Event_models', 'source_retraction'],
        'real_model_calls': 0, 'synthetic_instance_removed': True}))


if __name__ == '__main__':
    main()
