import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {classify,findings,inspect} from '../../tools/release-audit.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const parent=join(dirname(root),'sakie-ai-home-data');mkdirSync(parent,{recursive:true});
const isolated=mkdtempSync(join(parent,'release-readiness-'));
process.env.DOTENV_CONFIG_PATH=join(isolated,'missing.env');process.env.NODE_ENV='test';process.env.DEEPSEEK_API_KEY='';process.env.DEEPSEEK_MODEL='';
const {parseConfig}=await import('../src/config/env.ts');

test('candidate rules exclude credentials, databases and generated files but retain credential implementation source',()=>{
 for(const p of ['backend/.env','backend/.env.local','backend/owner.json','keys/key.pem','backend/data/sakie.db','logs/a.log','archive.sqlite-wal','.phase1-work/plan.json','node_modules/anything','agent-credentials-prod.json','../outside.ts'])assert.equal(classify(p),'excluded',p);
 for(const p of ['backend/src/modules/auth/credentials.ts','backend/.env.example','tools/release-audit.mjs','compose.release.json'])assert.equal(classify(p),'candidate',p);
 assert.equal(classify('docs/acl-s1-preflight-review.md'),'review-only');
});
test('excluded secret paths are not opened even when nonexistent',()=>{
 const result=inspect(isolated,['backend/.env','owner.json','sample.db']);assert.equal(result.excluded.length,3);assert.equal(result.candidate.length,0);
});
test('private identity and credential signatures are reported only as categories',()=>{
 const signature='-----BEGIN '+'OPENSSH PRIVATE KEY-----';const sid='S-1-5-21-'+'100-200-300-400';
 assert.deepEqual(findings(signature),['credential-signature']);assert.deepEqual(findings(sid),['machine-identity']);
 assert.deepEqual(findings('TOKEN='+'A'.repeat(40)),['environment-secret']);assert.deepEqual(findings("password='phase1-test-password-only'"),[]);
});
test('source manifest quarantines identity-bearing docs and blocks unsafe source without exposing its text',()=>{
 mkdirSync(join(isolated,'docs'));mkdirSync(join(isolated,'backend','src'),{recursive:true});
 writeFileSync(join(isolated,'docs','audit.md'),'S-1-5-21-'+'100-200-300-400');writeFileSync(join(isolated,'backend','src','safe.ts'),'export const value=1;');
 writeFileSync(join(isolated,'backend','src','unsafe.ts'),'sk-'+'x'.repeat(40));
 const result=inspect(isolated,['docs/audit.md','backend/src/safe.ts','backend/src/unsafe.ts']);
 assert.equal(result.candidate.length,1);assert.match(result.candidate[0].sha256,/^[a-f0-9]{64}$/);assert.equal(result.review[0].reasons[0],'machine-identity');assert.equal(result.blocked[0].reasons[0],'credential-signature');
 assert.ok(!JSON.stringify(result).includes('x'.repeat(40)));
});
test('production rejects volatile SQLite while development retains existing in-memory fixtures',()=>{
 assert.throws(()=>parseConfig({NODE_ENV:'production',PUBLIC_ORIGIN:'https://acceptance.invalid',DATABASE_PATH:':memory:'}),/persistent database/);
 assert.equal(parseConfig({NODE_ENV:'test',DATABASE_PATH:':memory:'}).databasePath,':memory:');
});
test('release profile has explicit durable stores and read-only identity; no automatic host directory creation',()=>{
 const profile=JSON.parse(readFileSync(join(root,'compose.release.json'),'utf8').replace(/^\uFEFF/,''));
 const backend=profile.services.backend;
 const parsed=parseConfig({...backend.environment,PUBLIC_ORIGIN:'https://acceptance.invalid'});
 assert.equal(parsed.secureCookies,true);assert.equal(parsed.databasePath,resolve('/app/data/sakie.db'));assert.equal(parsed.backupDir,resolve('/app/backups'));
 assert.notEqual(parsed.dataDir,parsed.backupDir);
 const identity=backend.volumes.find(v=>v.target===backend.environment.OWNER_CREDENTIAL_FILE);assert.equal(identity.read_only,true);assert.equal(identity.bind.create_host_path,false);
 for(const target of ['/app/data','/app/backups']){const mount=backend.volumes.find(v=>v.target===target);assert.equal(profile.volumes[mount.source].external,true);assert.ok(!mount.read_only);}
 assert.match(backend.environment.PUBLIC_ORIGIN,/\$\{PUBLIC_ORIGIN:\?/);assert.match(backend.env_file[0],/\$\{BACKEND_ENV_FILE:\?/);
});
test('release profile keeps API private and publishes only a loopback frontend with bounded logs',()=>{
 const p=JSON.parse(readFileSync(join(root,'compose.release.json'),'utf8').replace(/^\uFEFF/,''));
 assert.equal(p.services.backend.ports,undefined);assert.equal(p.services.frontend.env_file,undefined);
 assert.ok(p.services.frontend.ports.every(x=>x.startsWith('127.0.0.1:')));
 for(const service of Object.values(p.services)){assert.ok(Number(service.logging.options['max-file'])>0);assert.match(service.logging.options['max-size'],/^\d+m$/);}
 assert.ok(parseInt(p.services.backend.stop_grace_period)>10);
});
