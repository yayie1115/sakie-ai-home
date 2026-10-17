import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync,readFileSync,mkdirSync} from 'node:fs';
import {join,basename} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {startDemo,demoDirectory,demoPassword} from './chat-demo.mjs';

async function until(fn,description){for(let n=0;n<120;n++){try{const value=await fn();if(value)return value;}catch{}await delay(100);}throw new Error('Timed out: '+description);}
test('demo refuses real paths and unmarked run names',()=>{
  for(const name of ['../cloud','cloud','E:\\sakie-ai-home-data\\cloud','chat-demo-not-a-real-run'])assert.throws(()=>demoDirectory(name));
});
test('Edge UI login, fake reply, refresh and backend restart preserve one timeline',{timeout:60000},async()=>{
  let demo=await startDemo({port:0});let browser,ws;
  const run=basename(demo.dir),port=Number(new URL(demo.origin).port);
  try{
    assert.equal((await fetch(demo.origin+'/api/chat/conversations')).status,401);
    const profile=join(demo.dir,'browser-profile');mkdirSync(profile);
    const edge='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';assert.ok(existsSync(edge),'Edge required; no silent browser skip');
    browser=spawn(edge,['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore',windowsHide:true});
    const debuggerPort=await until(()=>{const p=join(profile,'DevToolsActivePort');return existsSync(p)&&Number(readFileSync(p,'utf8').split('\n')[0]);},'isolated browser');
    const pages=await (await fetch('http://127.0.0.1:'+debuggerPort+'/json/list')).json();
    ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((ok,fail)=>{ws.addEventListener('open',ok,{once:true});ws.addEventListener('error',fail,{once:true});});
    let seq=0;const pending=new Map();ws.addEventListener('message',event=>{const r=JSON.parse(event.data);if(r.id){const pair=pending.get(r.id);if(pair){pending.delete(r.id);r.error?pair.reject(new Error(r.error.message)):pair.resolve(r.result);}}});
    const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
    const evaluate=async expression=>{const r=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error('Browser expression failed');return r.result.value;};
    await cdp('Network.enable');await cdp('Network.setBlockedURLs',{urls:['https://*','http://localhost:*']});
    await cdp('Page.navigate',{url:demo.origin+'/demo/chat'});
    await until(()=>evaluate("!!document.querySelector('#owner-password')"),'login form');
    await evaluate(`(()=>{const e=document.querySelector('#owner-password');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(demoPassword)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await evaluate("document.querySelector('form').requestSubmit()");
    await until(()=>evaluate("!!document.querySelector('#chat-message') && !document.querySelector('#chat-message').disabled"),'chat timeline');
    assert.equal(await evaluate("document.querySelectorAll('select').length"),0);
    await evaluate("(()=>{const e=document.querySelector('#chat-message');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'synthetic browser hello');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await evaluate("document.querySelector('#chat-message').closest('form').requestSubmit()");
    await until(()=>evaluate("document.querySelectorAll('[aria-label=\"聊天历史\"] li').length===2 && document.body.innerText.includes('[假模型，无收费调用]')"),'fake reply');
    assert.equal(demo.calls,1);
    const saved=demo.db.prepare('SELECT id,content FROM chat_messages ORDER BY message_seq').all();assert.equal(saved.length,2);
    await cdp('Page.reload');await until(()=>evaluate("document.querySelectorAll('[aria-label=\"聊天历史\"] li').length===2"),'history after refresh');
    assert.equal(demo.calls,1);
    await demo.close();demo=await startDemo({resume:run,port});
    await cdp('Page.reload');await until(()=>evaluate("document.querySelectorAll('[aria-label=\"聊天历史\"] li').length===2"),'history after process restart');
    assert.deepEqual(demo.db.prepare('SELECT id,content FROM chat_messages ORDER BY message_seq').all(),saved);
    assert.equal(demo.calls,0);assert.equal(demo.db.prepare('SELECT count(*) n FROM chat_outbox').get().n,2);
    console.log(JSON.stringify({evidence:'browser-login-send-refresh-restart',messages:2,outbox:2,fakeCallsBeforeRestart:1,run}));
  }finally{if(ws)ws.close();if(browser)browser.kill();await demo.close();}
});
