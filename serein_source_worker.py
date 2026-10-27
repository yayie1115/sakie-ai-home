"""Host outbox worker, deployed disabled until withdrawal is certified."""
import argparse
import json
from source_protocol import SourceConflict


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--database', required=True)
    args = parser.parse_args()
    import memory_outbox
    import serein_bridge

    def send(event):
        bridge = serein_bridge.configured()
        if bridge is None:
            raise ValueError('Memory bridge unavailable')
        response = bridge.transport.post(bridge.base + '/bridge/source-events',
            headers={'Authorization': 'Bearer ' + bridge.token}, json=event,
            timeout=(1, 8), allow_redirects=False)
        if response.status_code == 409:
            raise SourceConflict('Receiver requires source lineage review')
        response.raise_for_status()
        return response.json()

    def inspect(instance):
        bridge = serein_bridge.configured()
        if bridge is None:
            raise ValueError('Memory bridge unavailable')
        response = bridge.transport.post(bridge.base + '/bridge/source-status',
            headers={'Authorization': 'Bearer ' + bridge.token}, json={'instance_id': instance},
            timeout=(1, 8), allow_redirects=False)
        if response.status_code == 409:
            raise SourceConflict('Receiver requires source lineage review')
        response.raise_for_status()
        return response.json()

    print(json.dumps(memory_outbox.drain(args.database, send, inspect=inspect)))


if __name__ == '__main__':
    main()
