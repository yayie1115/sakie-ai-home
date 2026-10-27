"""Consistent encrypted instance backups; restore only to a new isolated folder.

Reuses Morrow's authenticated encryption format. CLI secrets are file paths,
never password values. No remote upload or automatic retention deletion.
"""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import os
from pathlib import Path
import shutil
import sqlite3
import tarfile
import tempfile
from uuid import uuid4

from cloud_backup import encrypt_file, decrypt_file


def verify_tree(root):
    checked = 0
    for path in Path(root).rglob('*'):
        if path.is_file() and path.suffix in ('.db', '.sqlite', '.sqlite3'):
            with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)) as db:
                if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise ValueError('Restored SQLite integrity check failed')
            checked += 1
    return checked


def restore(source, target, passphrase):
    target = Path(target)
    if target.exists() or target.is_symlink():
        raise ValueError('Restore target must not exist')
    # Authentication must finish before any target is created.
    with tempfile.TemporaryDirectory(prefix='serein-decrypt-', dir=target.parent) as work:
        private = Path(work); os.chmod(private, 0o700)
        plain = private / 'snapshot.tar'
        decrypt_file(source, plain, passphrase)
        with tarfile.open(plain, 'r') as archive:
            for item in archive:
                p = Path(item.name)
                if p.is_absolute() or '..' in p.parts or not (item.isfile() or item.isdir()):
                    raise ValueError('Unsafe backup archive member')
            archive.extractall(private / 'verified', filter='data')
        checked = verify_tree(private / 'verified')
        # New target only, never overwrite a live database or merge directories.
        if target.exists() or target.is_symlink():
            raise ValueError('Restore target appeared during verification')
        (private / 'verified').rename(target)
        os.chmod(target, 0o700)
        return checked


def snapshot(roots, destination, passphrase):
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(destination, 0o700)
    if shutil.disk_usage(destination).free < 128 * 1024 * 1024:
        raise ValueError('Insufficient free space')
    target = destination / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid4().hex + '.enc')
    with tempfile.TemporaryDirectory(prefix='snapshot-', dir=destination) as work:
        private = Path(work); os.chmod(private, 0o700)
        files = private / 'files'; files.mkdir()
        for label, source in roots.items():
            if not label.isidentifier():
                raise ValueError('Invalid backup root label')
            source = Path(source).resolve()
            if destination.resolve().is_relative_to(source):
                raise ValueError('Backup destination must be outside every source root')
            for path in source.rglob('*'):
                if path.is_symlink():
                    raise ValueError('Backup does not follow symbolic links')
                if not path.is_file() or path.name.endswith(('-wal', '-shm', '-journal', '.lock', '.log')):
                    continue
                out = files / label / path.relative_to(source)
                out.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                if path.suffix in ('.db', '.sqlite', '.sqlite3'):
                    with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)) as src, \
                         closing(sqlite3.connect(out)) as dst:
                        src.backup(dst)
                else:
                    before = path.stat()
                    shutil.copyfile(path, out)
                    after = path.stat()
                    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                        raise ValueError('Instance files changed during backup; retry after quiescing writes')
                os.chmod(out, 0o600)
        verify_tree(files)
        plain = private / 'snapshot.tar'
        with tarfile.open(plain, 'w') as archive:
            for path in sorted(files.iterdir()):
                archive.add(path, arcname=path.name)
        pending = private / 'encrypted.pending'
        checksum = encrypt_file(plain, pending, passphrase)
        # Mandatory actual isolated decryption + SQLite verification before publish.
        restore(pending, private / 'restore-check', passphrase)
        os.chmod(pending, 0o600)
        pending.rename(target)
        return target, checksum


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('backup', 'restore'))
    parser.add_argument('--passphrase-file', required=True, type=Path)
    parser.add_argument('--root', action='append', default=[], help='Label=private-directory')
    parser.add_argument('--destination', required=True, type=Path)
    parser.add_argument('--source', type=Path)
    args = parser.parse_args()
    secret = args.passphrase_file.read_text().strip()
    if len(secret) < 16:
        raise ValueError('Backup credential is too short')
    if args.action == 'backup':
        path, checksum = snapshot(dict(item.split('=', 1) for item in args.root), args.destination, secret)
        print('BACKUP_VERIFIED', path.name, checksum)
    else:
        print('RESTORE_VERIFIED', restore(args.source, args.destination, secret))


if __name__ == '__main__':
    main()
