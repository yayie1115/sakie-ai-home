"""Opt-in encrypted joint snapshots; never restore over an existing target.

Callers must quiesce non-database writers. This utility reserves every declared
SQLite writer and the existing sender lock. It does not certify external/model
jobs, undeclared files, or release recall quarantine.
"""
from contextlib import ExitStack, closing
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile

import memory_outbox
import serein_backup
import source_protocol as protocol


def sha(path):
    value=hashlib.sha256()
    with open(path,'rb') as handle:
        for chunk in iter(lambda:handle.read(1024*1024),b''):value.update(chunk)
    return value.hexdigest()


def lineage(host,receiver):
    """Verify the complete retained receiver prefix, including lost ACKs."""
    host.row_factory=receiver.row_factory=sqlite3.Row
    control=host.execute('SELECT * FROM memory_bridge_control WHERE id=1').fetchone()
    if not control:raise ValueError('Missing host instance')
    instance=control['instance_id']
    if receiver.execute('SELECT 1 FROM morrow_source_streams WHERE instance!=? LIMIT 1',(instance,)).fetchone():
        raise ValueError('Unexpected receiver instance')
    if receiver.execute('SELECT 1 FROM morrow_source_stream_receipts WHERE instance!=? LIMIT 1',(instance,)).fetchone():
        raise ValueError('Unexpected receiver receipt instance')
    head=protocol.head(receiver,instance)
    receipts=list(receiver.execute('SELECT * FROM morrow_source_stream_receipts WHERE instance=? ORDER BY sequence',(instance,)))
    if len(receipts)!=head['sequence']:raise ValueError('Receiver receipt history incomplete')
    sequence=0;stamp=protocol.GENESIS;unconfirmed=0
    for row in host.execute('SELECT * FROM memory_bridge_outbox ORDER BY sequence'):
        event=protocol.envelope({'event_id':row['event_id'],'kind':row['kind'],'instance_id':instance,
            'message_id':row['message_id'],'session_id':row['session_id'],'message':json.loads(row['payload'])},
            row['sequence'],sequence,stamp)
        sequence,stamp=row['sequence'],protocol.fingerprint(event)
        if sequence<=head['sequence']:
            receipt=receipts[sequence-1]
            if (receipt['sequence'],receipt['event_id'],receipt['hash'])!=(sequence,row['event_id'],stamp):
                raise ValueError('Receiver prefix fork')
            if row['state']!='acknowledged':unconfirmed+=1
        elif row['state']=='acknowledged':
            raise ValueError('Receiver is older than acknowledged host history')
    if head['sequence']>sequence:raise ValueError('Host snapshot is older than receiver')
    return {'instance':instance,'host_sequence':sequence,'host_hash':stamp,'receiver':head,
            'lost_ack_count':unconfirmed,'recall_blocked':bool(control['recall_blocked']),
            'release_certified':False}


def tree_files(root):
    root=Path(root)
    if root.is_symlink() or not root.is_dir():raise ValueError('Invalid asset root')
    result={}
    for path in sorted(root.rglob('*')):
        if path.is_symlink():raise ValueError('Symlink in backup input')
        if path.is_file():result[path.relative_to(root).as_posix()]=sha(path)
    return result


def verify_restored(root):
    root=Path(root)
    manifest=json.loads((root/'metadata'/'joint.json').read_text(encoding='utf-8'))
    if manifest.get('format')!='morrow-joint-v1':raise ValueError('Unknown joint snapshot format')
    actual={p.relative_to(root).as_posix():sha(p) for p in root.rglob('*')
            if p.is_file() and p!=root/'metadata'/'joint.json'}
    if actual!=manifest['files']:raise ValueError('Joint snapshot inventory/hash mismatch')
    for name in manifest['databases']:
        with closing(sqlite3.connect((root/'databases'/(name+'.db')).as_uri()+'?mode=ro',uri=True)) as db:
            if db.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise ValueError('Database integrity failure')
            if db.execute('PRAGMA foreign_key_check').fetchone():raise ValueError('Database foreign-key failure')
    with closing(sqlite3.connect(root/'databases'/'host.db')) as host, \
         closing(sqlite3.connect(root/'databases'/'receiver.db')) as receiver:
        if lineage(host,receiver)!=manifest['lineage']:raise ValueError('Restored lineage mismatch')
    return manifest['lineage']


def restore(source,target,passphrase):
    """Verify privately before publishing an entirely new isolated directory."""
    target=Path(target)
    if target.exists() or target.is_symlink():raise ValueError('Restore target must not exist')
    with tempfile.TemporaryDirectory(prefix='joint-verify-',dir=target.parent) as temporary:
        private=Path(temporary);os.chmod(private,0o700)
        checked=private/'restored'
        serein_backup.restore(source,checked,passphrase)
        state=verify_restored(checked)
        if target.exists() or target.is_symlink():raise ValueError('Restore target appeared')
        checked.rename(target)
        return state


def snapshot(databases,assets,destination,passphrase,*,writers_quiesced=False):
    """No automatic service stop, credential discovery, or live recovery.

    Explicit databases must include host, receiver, and index. Assets must
    include private configuration/identity and all approved media directories;
    selecting these inputs is an operator responsibility, not auto-discovery.
    """
    if not writers_quiesced:raise ValueError('Non-database writers must be quiesced')
    if not {'host','receiver','index'}<=set(databases):raise ValueError('Required component missing')
    if not assets:raise ValueError('Configuration/identity coverage must be declared')
    if any(not name.isidentifier() for name in [*databases,*assets]):raise ValueError('Invalid component label')
    if any(Path(path).is_symlink() for path in databases.values()):raise ValueError('Symlink database component')
    paths={name:Path(path).resolve(strict=True) for name,path in databases.items()}
    if len(set(paths.values()))!=len(paths):raise ValueError('Database component alias')
    destination=Path(destination)
    if not destination.is_dir():raise ValueError('Private destination must already exist')
    with memory_outbox.delivery_lock(paths['host']) as acquired:
        if not acquired:raise ValueError('Source worker is busy')
        with ExitStack() as stack:
            # Same stable ordering for every invocation. Writer reservations
            # reject concurrent writes; backups use distinct READ connections.
            for path in sorted(paths.values()):
                db=stack.enter_context(closing(sqlite3.connect(path,timeout=0)))
                db.execute('BEGIN IMMEDIATE')
                stack.callback(db.rollback)
            with tempfile.TemporaryDirectory(prefix='joint-stage-',dir=destination) as temporary:
                private=Path(temporary);os.chmod(private,0o700)
                staged=private/'staged';(staged/'databases').mkdir(parents=True,mode=0o700)
                for name,path in paths.items():
                    with closing(sqlite3.connect(path.as_uri()+'?mode=ro',uri=True)) as reader, \
                         closing(sqlite3.connect(staged/'databases'/(name+'.db'))) as target:
                        reader.backup(target)
                inventories={}
                for name,root in assets.items():
                    root=Path(root)
                    if destination.resolve().is_relative_to(root.resolve()):raise ValueError('Destination inside input')
                    inventories[name]=tree_files(root)
                    for relative,stamp in inventories[name].items():
                        src=root/relative
                        # Do not accidentally copy another mutable database as
                        # an ordinary file. All SQLite stores must be declared.
                        with open(src,'rb') as handle:
                            if handle.read(16)==b'SQLite format 3\x00':raise ValueError('Undeclared SQLite asset')
                        out=staged/'assets'/name/relative;out.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
                        shutil.copyfile(src,out);os.chmod(out,0o600)
                        if sha(out)!=stamp:raise ValueError('Asset changed during copy')
                for name,root in assets.items():
                    if tree_files(root)!=inventories[name]:raise ValueError('Asset inventory changed')
                with closing(sqlite3.connect(staged/'databases'/'host.db')) as host, \
                     closing(sqlite3.connect(staged/'databases'/'receiver.db')) as receiver:
                    state=lineage(host,receiver)
                files={p.relative_to(staged).as_posix():sha(p) for p in staged.rglob('*') if p.is_file()}
                (staged/'metadata').mkdir(mode=0o700)
                (staged/'metadata'/'joint.json').write_text(json.dumps({'format':'morrow-joint-v1',
                    'databases':sorted(paths),'files':files,'lineage':state},sort_keys=True),encoding='utf-8')
                verify_restored(staged)
                package,checksum=serein_backup.snapshot({p.name:p for p in staged.iterdir()},private/'encrypted',passphrase)
                restore(package,private/'round-trip',passphrase)
                result=destination/package.name
                if result.exists():raise ValueError('Backup target already exists')
                package.rename(result)
                return result,checksum,state
