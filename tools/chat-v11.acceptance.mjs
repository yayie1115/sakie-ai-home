import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { initialWorkspace, compose, createRoom, sortedRooms, stage, submit, searchMessages, reviseMessage, restoreRoom, changeRoom } from '../frontend/src/modules/chat/v11/state.ts';

const root=resolve(import.meta.dirname,'..');
mkdirSync(join(root,'.phase1-work'),{recursive:true});
test('v11 synthetic state: room isolation, pending order, revision search, ordering and restore',()=>{
 let s=initialWorkspace(1_800_000_000_000);
 s=compose(s,'privateYan',{draft:'A',quote:{id:'intro',author:'谢亦言',text:'你回来啦。'}});
 s=compose(s,'home',{draft:'B'}); assert.equal(s.composers.privateYan.draft,'A'); assert.equal(s.composers.home.quote,undefined);
 s=stage(s,'privateYan','staged1',Date.now());assert.equal(s.composers.privateYan.draft,'');assert.equal(s.composers.privateYan.quote,undefined);
 assert.equal(s.composers.privateYan.pending[0].quote.id,'intro');s=compose(s,'privateYan',{draft:'second'});s=stage(s,'privateYan','staged2',Date.now());
 s=submit(s,'privateYan',Date.now());assert.equal(s.composers.privateYan.pending.length,0);assert.equal(s.messages.privateYan.at(-1).turnId,'staged1');
 assert.throws(()=>createRoom(s,'group',[],'invalid',Date.now()));assert.equal(createRoom(s,'private',['yan'],'duplicate',Date.now()).id,'privateYan');
 s=reviseMessage(s,'privateYan','intro','revised unique text');assert.equal(searchMessages(s,'privateYan','你回来啦','').length,0);assert.equal(searchMessages(s,'privateYan','unique','').length,1);
 s=changeRoom(s,'home',{pinned:true});assert.equal(sortedRooms(s)[0].id,'home');
 const now=Date.now();s=changeRoom(s,'home',{deletedAt:now});assert.equal(sortedRooms(s).some(r=>r.id==='home'),false);
 assert.equal(restoreRoom(s,'home',now+31*86400_000).rooms.find(r=>r.id==='home').deletedAt,now);
 s=restoreRoom(s,'home',now+100);assert.equal(s.rooms.find(r=>r.id==='home').deletedAt,undefined);
});

async function until(fn,label){for(let i=0;i<120;i++){try{const r=await fn();if(r)return r;}catch{}await delay(50);}throw Error('Timed out: '+label);}
test('v11 actual Edge E2E: mobile/desktop, isolated drafts, quote, staging, menus, creation, history, remarks and trash',{timeout:90000},async t=>{
 const dir=mkdtempSync(join(root,'.phase1-work','v11-browser-'));const profile=join(dir,'edge-profile');mkdirSync(profile);
 const requests=[];const errors=[];
 const server=createServer((req,res)=>{const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);requests.push(path);if(path.startsWith('/api')){res.writeHead(path==='/api/auth/session'?401:403,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'UNAUTHENTICATED'}));return;}const file=path.startsWith('/assets/')?join(root,'frontend/dist',path):join(root,'frontend/dist/index.html');if(!file.startsWith(join(root,'frontend/dist'))||!existsSync(file)){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',extname(file)==='.js'?'text/javascript':extname(file)==='.css'?'text/css':'text/html');res.end(readFileSync(file));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 let browser,ws;const waiting=new Map();
 try{
  const edge='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';assert.ok(existsSync(edge),'Edge required');
  browser=spawn(edge,['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore',windowsHide:true});
  const port=await until(()=>{const p=join(profile,'DevToolsActivePort');return existsSync(p)&&Number(readFileSync(p,'utf8').split('\n')[0]);},'browser');
  const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});
  let seq=0;ws.addEventListener('message',e=>{const r=JSON.parse(e.data);if(r.id){const w=waiting.get(r.id);if(w){waiting.delete(r.id);r.error?w.reject(Error(r.error.message)):w.resolve(r.result);}}else if(r.method==='Runtime.exceptionThrown')errors.push(r.params.exceptionDetails.text);});
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;waiting.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  const js=async expression=>{const r=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value;};
  const click=async selector=>{await js(`document.querySelector(${JSON.stringify(selector)})?.click()`);await delay(35);};
  const text=async(label,scope='document')=>{await js(`[...${scope}.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)})?.click()`);await delay(35);};
  const input=async(selector,value)=>{await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('input missing');Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await delay(35);};
  const open=async name=>click(`[aria-label="打开${name}"]`);
  const context=async selector=>{await js(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`);await delay(80);};
  await cdp('Runtime.enable');await cdp('Network.enable');await cdp('Network.setBlockedURLs',{urls:['https://*','http://localhost:*']});
  await cdp('Emulation.setDeviceMetricsOverride',{width:393,height:852,deviceScaleFactor:1,mobile:true});
  await cdp('Page.navigate',{url:origin+'/demo/chat-group'});await until(()=>js("!!document.querySelector('.v11-workspace')"),'workspace');
  await t.test('mobile opens list first; private/group drafts and quote remain isolated',async()=>{
   assert.equal(await js("getComputedStyle(document.querySelector('.v11-sidebar')).display"),'flex');await open('谢亦言');await input('[aria-label="输入消息"]','private draft');
   await context('[data-message-id="intro"] .v11-bubble');await text('引用');assert.equal(await js("document.querySelector('[aria-label=\"输入消息\"]').value"),'private draft');
   assert.equal(await js("!!document.querySelector('.v11-quote-preview')"),true);
   await click('[aria-label="返回会话列表"]');await open('小家群聊');await input('[aria-label="输入消息"]','group draft');assert.equal(await js("!!document.querySelector('.v11-quote-preview')"),false);
   await click('[aria-label="返回会话列表"]');await open('谢亦言');assert.equal(await js("document.querySelector('[aria-label=\"输入消息\"]').value"),'private draft');assert.equal(await js("!!document.querySelector('.v11-quote-preview')"),true);
  });
  await t.test('stage and final submission clear draft/quote, pending is in timeline, refresh retains state',async()=>{
   await text('暂存');assert.equal(await js("document.querySelector('[aria-label=\"输入消息\"]').value"),'');assert.equal(await js("document.querySelectorAll('.v11-timeline .pending').length"),1);assert.equal(await js("!!document.querySelector('.v11-quote-preview')"),false);
   await text('最终提交');assert.equal(await js("document.querySelectorAll('.v11-timeline .pending').length"),0);assert.equal(await js("document.querySelector('[aria-label=\"输入消息\"]').value"),'');
   await cdp('Page.reload');await until(()=>js("!!document.querySelector('.v11-workspace')"),'reload');await open('谢亦言');assert.match(await js("document.querySelector('.v11-timeline').textContent"),/private draft/);
  });
  await t.test('ordinary tap stays unselected; right-click toolbar stays below even at timeline bottom',async()=>{
   await click('[data-message-id="intro"] .v11-bubble');assert.equal(await js("document.querySelectorAll('.v11-bubblebar').length"),0);
   await context('.v11-message:last-child .v11-bubble');
   const geometry=await js("(()=>{const row=document.querySelector('.chosen'),b=row.querySelector('.v11-bubble').getBoundingClientRect(),bar=row.querySelector('.v11-bubblebar').getBoundingClientRect(),t=document.querySelector('.v11-timeline').getBoundingClientRect();return {below:bar.top>=b.bottom,visible:bar.bottom<=t.bottom+1};})()");assert.deepEqual(geometry,{below:true,visible:true});await text('关闭');
  });
  await t.test('long press opens actions while a scrolling movement cancels the gesture',async()=>{
   const point=await js("(()=>{const r=document.querySelector('[data-message-id=\"intro\"] .v11-bubble').getBoundingClientRect();return {x:r.x+15,y:r.y+15};})()");
   await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await delay(500);await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
   assert.equal(await js("document.querySelectorAll('.v11-bubblebar').length"),1);await text('关闭');
   await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',buttons:1,x:point.x+20,y:point.y});await delay(500);await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:point.x+20,y:point.y});
   assert.equal(await js("document.querySelectorAll('.v11-bubblebar').length"),0);
  });
  await t.test('pending bubbles can be reordered, edited and deleted without a model request',async()=>{
   await input('[aria-label="输入消息"]','first pending');await text('暂存');await input('[aria-label="输入消息"]','second pending');await text('暂存');
   await context('.v11-message:last-child .v11-bubble');await text('上移');await text('关闭');
   assert.equal(await js("document.querySelector('.v11-bubble.pending').textContent"),'second pending');
   await context('.v11-bubble.pending');await text('编辑');await input('[aria-label="编辑消息"]','edited pending');await text('保存');
   assert.equal(await js("document.querySelector('.v11-bubble.pending').textContent"),'edited pending');
   await context('.v11-bubble.pending');await text('删除');assert.equal(await js("document.querySelectorAll('.v11-bubble.pending').length"),1);await text('最终提交');
   const image=await cdp('Page.captureScreenshot',{format:'png'});writeFileSync(join(dir,'mobile.png'),Buffer.from(image.data,'base64'));
  });
  await t.test('history is a full page, highlights current text and jumps back to original message',async()=>{
   await click('[aria-label="聊天详情"]');await text('搜索 ›');await input('[aria-label="历史关键词"]','回来');assert.equal(await js("document.querySelectorAll('.v11-search-result mark').length"),1);await click('.v11-search-result');assert.equal(await js("document.querySelectorAll('.v11-panel').length"),0);
  });
  await t.test('new private chooses AI and reuses long-lived private; group starts empty and cannot auto-create',async()=>{
   await click('[aria-label="返回会话列表"]');await click('[aria-label="新建会话"]');await text('私聊');await click('.v11-private-choice');assert.equal(await js("document.querySelectorAll('[aria-label=\"打开谢亦言\"]').length"),1);
   await click('[aria-label="返回会话列表"]');await click('[aria-label="新建会话"]');await text('群聊');
   assert.equal(await js("document.querySelectorAll('.v11-member-choice input:checked').length"),0);assert.equal(await js("[...document.querySelectorAll('button')].find(e=>e.textContent==='创建群聊').disabled"),true);
   await click('.v11-member-choice input');await text('创建群聊');assert.equal(await js("document.querySelector('.v11-chat-title strong').textContent"),'新群聊');
  });
  await t.test('group remark stays local and name editor loads current object value',async()=>{
   await click('[aria-label="聊天详情"]');await text('修改群内备注 ›');assert.equal(await js("document.querySelector('[aria-label=\"新名称\"]').value"),'谢亦言');await input('[aria-label="新名称"]','群内小言');await click('[aria-label="修改备注"] button[type="submit"]');
   await text('修改群内备注 ›');assert.equal(await js("document.querySelector('[aria-label=\"新名称\"]').value"),'群内小言');await text('取消');
   await click('.v11-panel-head button');await click('[aria-label="返回会话列表"]');await open('谢亦言');assert.equal(await js("document.querySelector('.v11-chat-title strong').textContent"),'谢亦言');
  });
  await t.test('list long press survives the release click and preserves its action menu',async()=>{
   await click('[aria-label="返回会话列表"]');const point=await js("(()=>{const r=document.querySelector('[aria-label=\"打开谢亦言\"]').getBoundingClientRect();return{x:r.x+40,y:r.y+20};})()");
   await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await delay(500);await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});await delay(40);
   assert.equal(await js("!!document.querySelector('[aria-label=\"会话操作\"]')"),true);await text('取消');await open('谢亦言');
  });
  await t.test('list context menu supports pin and confirmed delete; trash restores entire synthetic room',async()=>{
   await click('[aria-label="返回会话列表"]');await context('[aria-label="打开谢亦言"]');await text('置顶');assert.match(await js("document.querySelector('.v11-conversation').textContent"),/谢亦言/);
   await context('[aria-label="打开谢亦言"]');await text('删除会话');assert.equal(await js("!!document.querySelector('[aria-label=\"确认删除会话\"]')"),true);await text('确认删除');assert.equal(await js("!!document.querySelector('[aria-label=\"打开谢亦言\"]')"),false);
   await click('[aria-label="会话回收站"]');await text('恢复');await click('.v11-panel-head button');await open('谢亦言');assert.match(await js("document.querySelector('.v11-timeline').textContent"),/private draft/);
  });
  await t.test('desktop keeps list, centers title, circular avatars; no backend traffic or runtime errors',async()=>{
   await cdp('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await delay(50);
   const layout=await js("(()=>{const h=document.querySelector('.v11-chat-head').getBoundingClientRect(),title=document.querySelector('.v11-chat-title').getBoundingClientRect(),a=document.querySelector('.v11-message .v11-avatar');return {center:Math.abs((title.left+title.right)/2-(h.left+h.right)/2)<1,sidebar:getComputedStyle(document.querySelector('.v11-sidebar')).display,radius:getComputedStyle(a).borderRadius,noPrivateNames:!document.querySelector('.v11-speaker')};})()");
   assert.deepEqual(layout,{center:true,sidebar:'flex',radius:'50%',noPrivateNames:true});assert.deepEqual(requests.filter(p=>p.startsWith('/api')),[]);assert.deepEqual(errors,[]);const image=await cdp('Page.captureScreenshot',{format:'png'});writeFileSync(join(dir,'desktop.png'),Buffer.from(image.data,'base64'));console.log('V11 screenshots: '+dir);
  });
  await t.test('leaving the public preview through a client-side link restores owner authentication',async()=>{
   await click('a[href="/chat"]');await until(()=>js("!!document.querySelector('#owner-password')"),'protected chat login');
   assert.equal(await js("!!document.querySelector('.v11-workspace')"),false);
   assert.ok(requests.includes('/api/auth/session'));assert.deepEqual(requests.filter(p=>p.startsWith('/api/chat')),[]);assert.deepEqual(errors,[]);
   await js('history.back()');await until(()=>js("!!document.querySelector('.v11-workspace')"),'return to preview');
  });
 }finally{if(ws?.readyState===WebSocket.OPEN)ws.close();browser?.kill();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
