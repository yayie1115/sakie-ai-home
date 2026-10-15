import express, { type ErrorRequestHandler } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { ValidationError } from './shared/validation.js';
import { memoryRouter } from './modules/memory/routes.js';
import { diaryRouter } from './modules/diary/routes.js';
import { dreamRouter } from './modules/dream/routes.js';
import { activityRouter } from './modules/activity/routes.js';
import { AuthError, AuthService } from './modules/auth/service.js';
import { authRouter } from './modules/auth/routes.js';
import { loadOwnerCredential } from './modules/auth/credentials.js';
import { config } from './config/env.js';
export function createApp(db:DatabaseSync,options:{auth?:AuthService}={}){
  const app=express();app.disable('x-powered-by');
  const auth=options.auth??new AuthService(db,{loadCredential:()=>loadOwnerCredential(config.credentialPath),publicOrigin:config.publicOrigin,allowedOrigins:config.allowedOrigins,secureCookies:config.secureCookies,sessionTtlMs:config.sessionTtlMs});
  app.get('/api/health',(_req,res)=>{db.prepare('SELECT 1').get();res.json({status:'ok',service:'sakie-ai-home'});});
  app.use('/api/auth',authRouter(auth));
  app.use('/api',(req,res,next)=>{res.setHeader('Cache-Control','no-store');auth.require(req);next();});
  app.use(express.json({limit:'1mb'}));
  app.use('/api/memories',memoryRouter(db));app.use('/api/diaries',diaryRouter(db));app.use('/api/dreams',dreamRouter(db));app.use('/api/activities',activityRouter(db));
  app.use((_req,res)=>res.status(404).json({error:'NOT_FOUND'}));
  const errorHandler:ErrorRequestHandler=(error,_req,res,_next)=>{
    const status=typeof error.status==='number'&&error.status>=400&&error.status<500?error.status:error instanceof AuthError?error.status:500;
    if(status===500)console.error('Request failed',error instanceof Error?error.name:'UnknownError');
    res.status(status).json({error:error instanceof AuthError?error.code:status===500?'INTERNAL_SERVER_ERROR':'INVALID_REQUEST',...(error instanceof ValidationError?{message:error.message}:{})});
  };app.use(errorHandler);return app;
}
