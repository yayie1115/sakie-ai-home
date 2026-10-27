"""Pinned upstream HTTP host plus closed-by-default source receiver.

No provider keys in argv/environment generated here. Uses existing private
config and token files. Automatic Event settings are never enabled by startup.
"""
import argparse
import os
from pathlib import Path
import subprocess
import hashlib


def verify_upstream(root):
    """Verify both the checkout and actually imported wheel/editable package."""
    import serein.config
    import serein_source_guard as guard
    root=Path(root).resolve()
    command=['git','--no-optional-locks','-c','safe.directory='+str(root),'-C',str(root)]
    revision=subprocess.check_output(command+['rev-parse','HEAD'],text=True).strip()
    changes=subprocess.check_output(command+['diff','--name-only','HEAD'],text=True).strip()
    if revision!=guard.PINNED or changes:
        raise ValueError('Source receiver requires the audited, unchanged upstream revision')
    package=Path(serein.config.__file__).resolve().parent
    files=subprocess.check_output(command+['ls-files','-z','src/serein'],text=True).split('\0')
    checked=0
    for name in filter(None,files):
        relative=Path(name).relative_to('src/serein');source=root/name;loaded=package/relative
        if (not source.is_file() or not loaded.is_file() or source.is_symlink() or loaded.is_symlink()
                or hashlib.sha256(source.read_bytes()).digest()!=hashlib.sha256(loaded.read_bytes()).digest()):
            raise ValueError('Imported Serein package differs from audited source')
        checked+=1
    if not checked:raise ValueError('Audited package manifest is empty')
    return checked


def create_guarded_app(settings, token, policy_path):
    import serein_source_guard as guard
    guard.install_runtime()
    from serein.core.store import Store
    with Store(settings.database,read_only=True) as store:
        if store.conn.execute('PRAGMA user_version').fetchone()[0]!=9:
            raise ValueError('Receiver requires the already initialized audited schema')
    from serein_source_projection import Projector
    projector=Projector(settings)
    from serein.api.http import create_app
    from serein_source_receiver import register
    app=create_app(settings,token=token,live=True)
    register(app,settings,projector,token,policy_path)
    return app


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--config',type=Path,required=True)
    parser.add_argument('--policy',type=Path,required=True)
    parser.add_argument('--port',type=int,default=8011)
    parser.add_argument('--upstream-root',type=Path,required=True)
    parser.add_argument('--check-upstream-only',action='store_true')
    args=parser.parse_args()
    checked=verify_upstream(args.upstream_root)
    if args.check_upstream_only:
        print('PINNED_IMPORTED_PACKAGE_VERIFIED',checked)
        return
    token_path=os.environ.get('SEREIN_HTTP_TOKEN_FILE')
    if not token_path:raise ValueError('Private HTTP token file required')
    token=Path(token_path).read_text(encoding='utf-8').strip()
    if not token:raise ValueError('Empty HTTP token')
    # Upstream configured-model clients may consult this existing instance
    # credential; it is not a provider key or a process command-line argument.
    os.environ['SEREIN_HTTP_TOKEN']=token
    from serein.config import load_settings
    settings=load_settings(args.config)
    import uvicorn
    uvicorn.run(create_guarded_app(settings,token,args.policy),host='127.0.0.1',port=args.port,
                access_log=False,log_level='warning')


if __name__=='__main__':main()
