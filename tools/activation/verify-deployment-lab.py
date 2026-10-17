"""Fresh synthetic Compose lab only. No production paths, model calls or DNS changes."""
import http.client, ssl, socket, json, pathlib, subprocess, sys, time, re, os
root=pathlib.Path(sys.argv[1]).resolve()
if not re.fullmatch(r'/home/ubuntu/sakie-activation-lab-[a-f0-9]{8}',str(root)):
    raise SystemExit('Unexpected lab scope')
scope=json.loads((root/'scope.json').read_text())
assert scope['remote']==str(root) and scope['project']==root.name
# Validate the closed lab scope BEFORE any Docker command, including restart.
config=json.loads((root/'compose.json').read_text())
assert config['name']==root.name
backend_config=config['services']['backend']
assert backend_config['image']==root.name+':lab'
assert backend_config['environment']['DEEPSEEK_API_KEY']=='' and backend_config['environment']['DEEPSEEK_MODEL']==''
assert backend_config['ports']==['127.0.0.1:13401:3000']
assert [m['source'] for m in backend_config['volumes']]==[str(root/'data'),str(root/'backups'),str(root/'identity/owner.json')]
assert backend_config['env_file']==['./identity/backend.env']
assert config['services']['nginx']['ports']==['127.0.0.1:13443:8443']
for asset in [root/'compose.json',root/'data',root/'backups',root/'identity',root/'identity/owner.json']:
    assert not asset.is_symlink()
os.umask(0o077)
results=[]
def record(name, detail=True): results.append({'name':name,'passed':True,'detail':detail})
def command(*args):
    return subprocess.check_output(args,cwd=root,text=True,stderr=subprocess.PIPE,timeout=60).strip()
def compose(*args): return command('sudo','-n','docker','compose','-f','compose.json',*args)
def inspect(cid): return json.loads(command('sudo','-n','docker','inspect',cid))[0]
context=ssl.create_default_context(cafile=str(root/'tls/fullchain.pem'))
def request(path, method='GET', body=None, headers=None):
    c=http.client.HTTPSConnection('activation.example.invalid',13443,context=context,timeout=5)
    c._create_connection=lambda address,timeout,source_address=None: socket.create_connection(('127.0.0.1',13443),timeout)
    payload=json.dumps(body).encode() if body is not None else None
    h={'Content-Type':'application/json',**(headers or {})}
    c.request(method,path,body=payload,headers=h);r=c.getresponse();raw=r.read();status=r.status;rh=dict((k.lower(),v) for k,v in r.getheaders());c.close()
    try: data=json.loads(raw)
    except (ValueError,UnicodeError): data=None
    return status,rh,data
try:
    compose('config','-q');record('compose-configuration')
    command('sudo','-n','docker','compose','-f','compose.json','exec','-T','nginx','nginx','-t');record('nginx-configuration')
    assert request('/api/health')[0]==200
    assert request('/api/memories')[0]==401
    assert request('/ws')[0]==404 and request('/')[0]==404
    assert request('/api/auth/login','POST',{'password':'synthetic-lab-owner-only'},{'Origin':'https://untrusted.example.invalid'})[0]==403
    record('tls-routing-auth-origin-and-ws-boundary')
    status,headers,data=request('/api/auth/login','POST',{'password':'synthetic-lab-owner-only'},{'Origin':scope['origin']})
    assert status==200 and data['authenticated']
    cookie=headers['set-cookie'];assert all(s in cookie for s in ['HttpOnly','Secure','SameSite=Strict'])
    h={'Cookie':cookie.split(';',1)[0],'Origin':scope['origin'],'X-CSRF-Token':data['csrfToken']}
    assert request('/api/memories','POST',{'content':'synthetic deployment persistence','type':'lab','importance':1},{'Cookie':h['Cookie'],'Origin':scope['origin']})[0]==403
    status,_,created=request('/api/memories','POST',{'content':'synthetic deployment persistence','type':'lab','importance':1},h)
    assert status==201;record('secure-session-csrf-and-synthetic-write')
    backend=compose('ps','-q','backend');before=inspect(backend)
    assert before['Config']['User']=='node'
    assert before['HostConfig']['CapDrop']==['ALL'] and 'no-new-privileges:true' in before['HostConfig']['SecurityOpt']
    assert before['HostConfig']['Memory']==512*1024*1024
    assert before['HostConfig']['PidsLimit']==96
    assert before['HostConfig']['RestartPolicy']['Name']=='unless-stopped'
    assert all(p['HostIp']=='127.0.0.1' for mappings in before['NetworkSettings']['Ports'].values() if mappings for p in mappings)
    mounts={m['Destination']:m for m in before['Mounts']}
    assert not mounts['/run/sakie/owner.json']['RW']
    assert mounts['/app/data']['Source']==str(root/'data')
    probe="const fs=require('fs');let denied=false;try{fs.appendFileSync('/run/sakie/owner.json','x')}catch(e){denied=e.code==='EROFS'||e.code==='EACCES'}if(!denied)process.exit(1);console.log(JSON.stringify({uid:process.getuid(),dataMode:fs.statSync('/app/data').mode&511,backupMode:fs.statSync('/app/backups').mode&511,ownerMode:fs.statSync('/run/sakie/owner.json').mode&511}));"
    perms=json.loads(compose('exec','-T','backend','node','-e',probe));assert perms=={'uid':1000,'dataMode':448,'backupMode':448,'ownerMode':256}
    record('loopback-mounts-runtime-identity-resource-caps',perms)
    compose('restart','backend')
    deadline=time.time()+30
    while True:
        try:
            if request('/api/health')[0]==200: break
        except (OSError,http.client.HTTPException): pass
        if time.time()>deadline: raise AssertionError('restart recovery timeout')
        time.sleep(.25)
    assert request('/api/memories/'+created['id'],headers=h)[2]['content']==created['content']
    record('container-restart-persists-record-and-session')
    # Application-level TERM: Docker kill/stop deliberately suppresses restart policy; PID1 ignores in-namespace KILL.
    assert inspect(backend)['Config']['Labels']['com.docker.compose.project']==root.name
    try: compose('exec','-T','backend','node','-e',"process.kill(1,'SIGTERM')")
    except subprocess.CalledProcessError: pass
    deadline=time.time()+40
    while True:
        try:
            current=inspect(backend)
            if current['RestartCount']>before['RestartCount'] and request('/api/health')[0]==200: break
        except (OSError,http.client.HTTPException,subprocess.CalledProcessError): pass
        if time.time()>deadline: raise AssertionError('application exit restart timeout')
        time.sleep(.5)
    assert request('/api/memories/'+created['id'],headers=h)[2]['content']==created['content']
    integrity=compose('exec','-T','backend','node','-e',"const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/app/data/sakie.db',{readOnly:true});const r=d.prepare('PRAGMA integrity_check').get();d.close();if(Object.values(r)[0]!=='ok')process.exit(1);console.log('ok')")
    assert integrity=='ok';record('application-exit-unless-stopped-recovery-and-integrity')
    ids=compose('ps','-q').splitlines()
    stats=command('sudo','-n','docker','stats','--no-stream','--format','{{json .}}',*ids)
    resources=[json.loads(line) for line in stats.splitlines()]
    record('resource-snapshot-not-peak',[{k:r[k] for k in ['Name','CPUPerc','MemUsage','PIDs']} for r in resources])
    result={'passed':True,'checks':results,'sourceCommit':scope['sourceCommit'],'adaptations':scope['adaptations'],'notTested':['host reboot','real login transition','real credentials/data','public DNS/TLS cutover','real model requests','production peak load']}
except Exception as e:
    result={'passed':False,'checks':results,'errorType':type(e).__name__,'error':str(e)[:180]}
finally:
    (root/'result.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result,indent=2))
if not result['passed']: sys.exit(1)
