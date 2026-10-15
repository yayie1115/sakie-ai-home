import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Request } from 'express';
import { passwordDigest, type OwnerCredential } from './credentials.js';
export class AuthError extends Error {constructor(readonly status:number,readonly code:string){super(code);}}
export interface AuthOptions { loadCredential:()=>OwnerCredential|undefined; publicOrigin:string; secureCookies:boolean; allowedOrigins?:readonly string[]; sessionTtlMs?:number; }
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const equal=(a:string,b:string)=>{const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);};
export class AuthService {
  private failures=new Map<string,{count:number;expires:number}>();private inFlight=0;
  constructor(private db:DatabaseSync,readonly options:AuthOptions){}
  checkOrigin(req:Request){const origin=req.get('origin');if(origin&&![this.options.publicOrigin,...(this.options.allowedOrigins??[])].includes(origin))throw new AuthError(403,'ORIGIN_REJECTED');}
  async login(password:unknown,ip:string){
    const now=Date.now();
    for(const[key,value]of this.failures)if(value.expires<=now)this.failures.delete(key);
    const attempt=this.failures.get(ip);
    if((attempt?.count??0)>=5||this.inFlight>=2)throw new AuthError(429,'LOGIN_RATE_LIMITED');
    const credential=this.options.loadCredential();if(!credential)throw new AuthError(503,'AUTH_NOT_CONFIGURED');
    if(typeof password!=='string'||password.length>256||password.length<1)throw new AuthError(400,'INVALID_LOGIN');
    if(this.failures.size>=1024&&!this.failures.has(ip))throw new AuthError(429,'LOGIN_RATE_LIMITED');
    this.failures.set(ip,{count:(attempt?.count??0)+1,expires:attempt?.expires??now+600000});
    this.inFlight++;
    let valid:boolean;
    try {valid=timingSafeEqual(await passwordDigest(password,credential),Buffer.from(credential.passwordHash,'hex'));}finally{this.inFlight--;}
    if(!valid)throw new AuthError(401,'INVALID_CREDENTIALS');
    // Rotation during password verification must not issue a session for an obsolete credential.
    if(this.options.loadCredential()?.id!==credential.id)throw new AuthError(401,'INVALID_CREDENTIALS');
    this.failures.delete(ip);
    const token=randomBytes(32).toString('base64url');
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now);
    this.db.prepare('INSERT INTO auth_sessions(token_hash,credential_version,expires_at) VALUES (?,?,?)').run(hash(token),credential.id,now+(this.options.sessionTtlMs??604800000));
    return {token,csrfToken:hash('csrf:'+token)};
  }
  session(req:Request):{token:string;csrfToken:string}|null {
    const cookies=(req.headers.cookie??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith('sakie_session='));
    if(cookies.length!==1)return null;
    const token=cookies[0].slice('sakie_session='.length);if(!/^[A-Za-z0-9_-]{43}$/.test(token))return null;
    const credential=this.options.loadCredential();if(!credential)return null;
    const row=this.db.prepare('SELECT 1 FROM auth_sessions WHERE token_hash=? AND credential_version=? AND expires_at>?').get(hash(token),credential.id,Date.now());
    return row?{token,csrfToken:hash('csrf:'+token)}:null;
  }
  require(req:Request){const session=this.session(req);if(!session)throw new AuthError(401,'UNAUTHENTICATED');
    if(!['GET','HEAD','OPTIONS'].includes(req.method)){this.checkOrigin(req);const csrf=req.get('x-csrf-token');if(!csrf||!equal(csrf,session.csrfToken))throw new AuthError(403,'CSRF_REJECTED');}
    return session;
  }
  logout(token:string){this.db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(hash(token));}
  cookie(token:string,remove=false){return 'sakie_session='+token+'; Path=/; HttpOnly; SameSite=Strict; Max-Age='+(remove?0:Math.floor((this.options.sessionTtlMs??604800000)/1000))+(this.options.secureCookies?'; Secure':'');}
}
