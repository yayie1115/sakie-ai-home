import express, { Router } from 'express';
import { AuthService } from './service.js';
export function authRouter(auth:AuthService){
  const router=Router();router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
  router.post('/login',express.json({limit:'4kb'}),async(req,res)=>{auth.checkOrigin(req);const session=await auth.login(req.body?.password,req.ip??'unknown');res.setHeader('Set-Cookie',auth.cookie(session.token));res.json({authenticated:true,csrfToken:session.csrfToken});});
  router.get('/session',(req,res)=>{const session=auth.require(req);res.json({authenticated:true,csrfToken:session.csrfToken});});
  router.post('/logout',(req,res)=>{const session=auth.require(req);auth.logout(session.token);res.setHeader('Set-Cookie',auth.cookie('',true));res.status(204).end();});
  return router;
}
