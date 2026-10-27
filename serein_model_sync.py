"""Sync provider references, never provider secrets, into private Serein settings."""
import argparse
from pathlib import Path
from urllib.parse import urlsplit
import json


def synchronize(settings, origin, token, *, prepare=False):
    import httpx
    from serein.deployment import read_settings, save_settings
    from serein.configured_models import memory_status, prepare_selected
    url = urlsplit(origin)
    if url.scheme != 'http' or url.hostname not in ('localhost', '127.0.0.1', '::1') or url.path not in ('', '/') or url.query or url.fragment or url.username:
        raise ValueError('Explicit loopback Morrow origin required')
    with httpx.Client(timeout=5, follow_redirects=False, trust_env=False) as client:
        r = client.get(origin.rstrip('/') + '/internal/memory-models/config',
                       headers={'Authorization': 'Bearer ' + token})
        r.raise_for_status(); selected = r.json()
    current = read_settings(settings.database)
    marker = 'morrow-memory-'
    preserved = [m for m in current['models'] if not m['id'].startswith(marker)]
    assignments = dict(current['assignments'])
    ready_roles = []
    for role in ('embedding', 'reranker'):
        info = selected[role]
        identifier = marker + role + '-r' + str(selected['revision']) + '-' + info.get('generation','legacy')
        if info['selection'] and info['verified']:
            model = {'id': identifier, 'label': 'Morrow memory ' + role,
                     'model': info['selection']['model_id'],
                     'base_url': origin.rstrip('/') + '/internal/memory-models',
                     'api_key': token, 'protocol': 'openai'}
            if role == 'embedding':
                model['dimension'] = info['dimension']
            preserved.append(model); assignments[role] = identifier; ready_roles.append(role)
        else:
            assignments[role] = ''
    if current['models'] != preserved or current['assignments'] != assignments:
        save_settings(settings.database, {'models': preserved, 'assignments': assignments})
    if prepare:
        if len(ready_roles) != 2:
            raise ValueError('Both actual model interfaces must be verified before preparation')
        prepare_selected(settings)
    return {'selected_revision': selected['revision'], 'verified_roles': ready_roles,
            'memory': memory_status(settings), 'provider_keys_copied': False}


def main():
    # This existing maintenance process also opens the canonical database.
    # Register the same epoch functions; do not create guards or enable sources.
    from serein_source_guard import install_runtime
    install_runtime()
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--morrow-origin', default='http://127.0.0.1:5151')
    parser.add_argument('--token-file', required=True, type=Path)
    parser.add_argument('--prepare', action='store_true', help='Explicit, budgeted embedding requests; never automatic')
    args = parser.parse_args()
    from serein.config import load_settings
    print(json.dumps(synchronize(load_settings(args.config), args.morrow_origin,
                                 args.token_file.read_text().strip(), prepare=args.prepare)))


if __name__ == '__main__':
    main()
