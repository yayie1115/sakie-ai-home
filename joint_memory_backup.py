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
import tarfile
from uuid import uuid4
import re
import subprocess

import memory_outbox
import serein_backup
import source_protocol as protocol


def sha(path):
    value=hashlib.sha256()
    with open(path,'rb') as handle:
        for chunk in iter(lambda:handle.read(1024*1024),b''):value.update(chunk)
    return value.hexdigest()


def _unit_status(unit):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@-]*\.(service|timer)',unit):raise ValueError('Invalid maintenance unit')
    result=subprocess.run(['systemctl','show',unit,'--property=ActiveState,SubState,MainPID,InvocationID'],
                          check=True,capture_output=True,text=True,timeout=5)
    return dict(line.split('=',1) for line in result.stdout.splitlines() if '=' in line)


def _open_holders(paths):
    """Read-only Linux descriptor audit. Unreadable processes are blockers."""
    if not Path('/proc').is_dir():return [],1
    wanted={str(Path(path).resolve()) for path in paths};holders=[];unreadable=0
    for process in Path('/proc').iterdir():
        if not process.name.isdigit() or int(process.name)==os.getpid():continue
        try:
            for descriptor in (process/'fd').iterdir():
                try:
                    target=os.readlink(descriptor)
                    if target in wanted or target.removesuffix(' (deleted)') in wanted:
                        holders.append(int(process.name));break
                except FileNotFoundError:continue
        except FileNotFoundError:continue
        except PermissionError:unreadable+=1
    return sorted(holders),unreadable


def maintenance_status(databases,units):
    """Inspect an explicit writer inventory; never stops or restarts a service.

    Unknown jobs, inaccessible /proc, active timers, and open external database
    handles fail closed. Unit completeness and media writers still require
    operator review; this is not a global source-release certificate.
    """
    if not units:raise ValueError('Explicit writer service/timer inventory required')
    paths={name:Path(path).resolve(strict=True) for name,path in databases.items()}
    states={unit:_unit_status(unit) for unit in sorted(set(units))}
    blockers=[]
    for unit,state in states.items():
        if state.get('ActiveState')!='inactive' or state.get('SubState')!='dead' or state.get('MainPID','0')!='0':
            blockers.append('unit_not_quiescent:'+unit)
    checks={'host':[
        ('night_runs',"status IN ('queued','running')"),('proactive_message_jobs',"status='running'"),
        ('image_descriptions',"status='running'"),('sessions',"title_state='generating'")],
        'receiver':[('pipeline_jobs',"output_json IS NULL AND NOT EXISTS(SELECT 1 FROM pipeline_batches b "
                    "WHERE b.id=pipeline_jobs.batch_id AND (b.status='done' OR b.status LIKE 'superseded_%'))"),
                    ('pipeline_batches',"status!='done' AND status NOT LIKE 'superseded_%'")]}
    jobs={}
    for component,queries in checks.items():
        if component not in paths:blockers.append('missing_component:'+component);continue
        with closing(sqlite3.connect(paths[component].as_uri()+'?mode=ro',uri=True)) as db:
            for table,condition in queries:
                try:
                    count=db.execute('SELECT count(*) FROM '+table+' WHERE '+condition).fetchone()[0]
                    jobs[component+':'+table]=count
                    if count:blockers.append('unfinished_jobs:'+component+':'+table)
                except sqlite3.Error:blockers.append('unknown_jobs:'+component+':'+table)
    holders,unreadable=_open_holders(paths.values())
    if holders:blockers.append('external_database_handles')
    if unreadable:blockers.append('unreadable_process_descriptors')
    identities={name:{'path':str(path),'device':path.stat().st_dev,'inode':path.stat().st_ino} for name,path in paths.items()}
    return {'version':'morrow-maintenance-v1','ready':not blockers,'scope':protocol.fingerprint(identities),
            'units':states,'jobs':jobs,'holders':holders,'unreadable_processes':unreadable,
            'blockers':blockers,'release_certified':False}


def controlled_snapshot(databases,assets,destination,passphrase,*,units):
    """Production maintenance entry: inspect before AND after frozen copying."""
    return snapshot(databases,assets,destination,passphrase,writers_quiesced=True,
                    maintenance_probe=lambda:maintenance_status(databases,units))


def resume_review(root,peer_head):
    """A past snapshot is not permission to replace a newer active instance."""
    archived=verify_restored(root)
    same=peer_head==archived['receiver']
    return {'ready_for_operator_review':same,'release_certified':False,
            'recall_blocked':archived['recall_blocked'],
            'reason':'fresh_runtime_and_asset_review_required' if same else 'peer_lineage_differs_stop'}


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
    if root.is_symlink():raise ValueError('Invalid asset root')
    if root.is_file():return {root.name:sha(root)}
    if not root.is_dir():raise ValueError('Invalid asset root')
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


def snapshot(databases,assets,destination,passphrase,*,writers_quiesced=False,maintenance_probe=None):
    """No automatic service stop, credential discovery, or live recovery.

    Explicit databases must include host, receiver, and index. Assets must
    include private configuration/identity and all approved media directories;
    selecting these inputs is an operator responsibility, not auto-discovery.
    """
    if not writers_quiesced:raise ValueError('Non-database writers must be quiesced')
    audit=maintenance_probe() if maintenance_probe else None
    if audit is not None and audit.get('ready') is not True:raise ValueError('Maintenance audit blocked snapshot')
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
                        # Normalize ONLY the new frozen copy. A copied WAL-mode
                        # header otherwise creates fresh -wal/-shm during read
                        # verification, outside the authenticated inventory.
                        if target.execute('PRAGMA journal_mode=DELETE').fetchone()[0]!='delete':
                            raise ValueError('Snapshot journal normalization failed')
                inventories={}
                for name,root in assets.items():
                    root=Path(root)
                    if destination.resolve().is_relative_to(root.resolve()):raise ValueError('Destination inside input')
                    inventories[name]=tree_files(root)
                    for relative,stamp in inventories[name].items():
                        src=root if root.is_file() else root/relative
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
                    'databases':sorted(paths),'files':files,'lineage':state,'maintenance':audit},sort_keys=True),encoding='utf-8')
                verify_restored(staged)
                # These SQLite files are ALREADY consistent frozen snapshots.
                # A second SQLite backup may alter header bytes and invalidate
                # the authenticated inventory even though logical rows match.
                plain=private/'joint.tar'
                with tarfile.open(plain,'w') as archive:
                    for child in sorted(staged.iterdir()):archive.add(child,arcname=child.name)
                package=private/(uuid4().hex+'.enc')
                checksum=serein_backup.encrypt_file(plain,package,passphrase)
                os.chmod(package,0o600)
                restore(package,private/'round-trip',passphrase)
                if maintenance_probe and maintenance_probe()!=audit:raise ValueError('Maintenance state changed; snapshot not published')
                result=destination/package.name
                if result.exists():raise ValueError('Backup target already exists')
                package.rename(result)
                return result,checksum,state
