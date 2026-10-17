// Prepares a fresh synthetic lab only; never installs or deploys automatically.
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {render} from './render.mjs';
import {createOwnerCredential} from '../../backend/dist/modules/auth/credentials.js';
const dir=mkdtempSync(resolve('.phase1-work','compose-runtime-'));
const id=randomUUID().slice(0,8),remote='/home/ubuntu/sakie-activation-lab-'+id;
const origin='https://activation.example.invalid:13443';
const generated=render(origin,process.execPath,['S',1,5,21,111,222,333,444].join('-'));
const c=generated.compose;c.name='sakie-activation-lab-'+id;
const b=c.services.backend;b.image=c.name+':lab';b.build.context='./source';b.env_file=['./identity/backend.env'];b.environment.DEEPSEEK_API_KEY='';b.environment.DEEPSEEK_MODEL='';
b.ports=['127.0.0.1:13401:3000'];
b.volumes[0].source=remote+'/data';b.volumes[1].source=remote+'/backups';b.volumes[2].source=remote+'/identity/owner.json';
b.healthcheck.interval='2s';b.healthcheck.start_period='10s';
c.services.nginx={image:'nginx:1.28-alpine',ports:['127.0.0.1:13443:8443'],user:'1000:1000',read_only:true,tmpfs:['/tmp'],volumes:[{type:'bind',source:remote+'/nginx.conf',target:'/etc/nginx/nginx.conf',read_only:true,bind:{create_host_path:false}},{type:'bind',source:remote+'/tls',target:'/etc/letsencrypt/live/activation.example.invalid',read_only:true,bind:{create_host_path:false}}],entrypoint:['nginx','-g','daemon off;'],depends_on:{backend:{condition:'service_healthy'}},mem_limit:'64m',cpus:0.25,pids_limit:32,cap_drop:['ALL'],security_opt:['no-new-privileges:true'],logging:b.logging};
// New bridge-only Nginx routes to backend service DNS; host Nginx stays untouched.
const nginx='worker_processes 1;\nerror_log /dev/stderr warn;\npid /tmp/nginx.pid;\nevents { worker_connections 128; }\nhttp {\n client_body_temp_path /tmp/client; proxy_temp_path /tmp/proxy; fastcgi_temp_path /tmp/fastcgi; uwsgi_temp_path /tmp/uwsgi; scgi_temp_path /tmp/scgi;\n'+generated.nginx.replace('listen 443 ssl','listen 8443 ssl').replace('127.0.0.1:3401','backend:3000')+'}\n';
for(const x of ['identity','tls'])mkdirSync(join(dir,x));
writeFileSync(join(dir,'compose.json'),JSON.stringify(c,null,2));writeFileSync(join(dir,'nginx.conf'),nginx);
writeFileSync(join(dir,'identity','backend.env'),'DEEPSEEK_API_KEY=\nDEEPSEEK_MODEL=\n',{mode:0o600});
writeFileSync(join(dir,'identity','owner.json'),JSON.stringify(await createOwnerCredential('synthetic-lab-owner-only')),{mode:0o600});
execFileSync('E:/Git/usr/bin/openssl.exe',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=activation.example.invalid','-addext','subjectAltName=DNS:activation.example.invalid','-keyout',join(dir,'tls','privkey.pem'),'-out',join(dir,'tls','fullchain.pem')],{stdio:'ignore'});
execFileSync('git',['archive','--format=tar','-o',join(dir,'source.tar'),'HEAD']);
writeFileSync(join(dir,'scope.json'),JSON.stringify({version:1,remote,project:c.name,origin,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),adaptations:['fresh paths/project/loopback ports','backend actual PORT 3000; health interval 2s','new bridge-only Nginx uses backend service DNS; TLS 8443, not host Nginx','self-signed test certificate, no DNS/host trust changes','empty model configuration, synthetic owner only']},null,2));
console.log(JSON.stringify({dir,remote,project:c.name}));
