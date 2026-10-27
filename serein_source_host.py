"""Pinned upstream HTTP host plus closed-by-default source receiver.

No provider keys in argv/environment generated here. Uses existing private
config and token files. Automatic Event settings are never enabled by startup.
"""
import argparse
import os
from pathlib import Path
import subprocess


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
    args=parser.parse_args()
    import serein
    import serein_source_guard as guard
    source=Path(serein.__file__).resolve().parents[2]
    revision=subprocess.check_output(['git','-c','safe.directory='+str(source),'-C',str(source),'rev-parse','HEAD'],text=True).strip()
    changes=subprocess.check_output(['git','-c','safe.directory='+str(source),'-C',str(source),'diff','--name-only','HEAD'],text=True).strip()
    if revision!=guard.PINNED or changes:
        raise ValueError('Source receiver requires the audited, unchanged upstream revision')
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
