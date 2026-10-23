// Run with local checkouts: node tests/pop-translation.integration.cjs VERBA POP_IOS POP_AND POP_APK
// Real Relay HTTP, Verba jobs and Pop notification cores; only AI/push delivery are fixtures.
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const http=require('node:http');
const {randomBytes,createECDH}=require('node:crypto');
const [verba,ios,and,apk]=process.argv.slice(2);
if(!apk)throw Error('Provide Verba, iOS, AND and APK checkout paths.');
const {createRelay}=require('../server/index.cjs');
const {createRouting}=require('../server/notification-routing.cjs');
const {createJobs}=require(path.join(verba,'server-plugin/jobs.cjs'));
const {prepareSelected}=require(path.join(verba,'server-plugin/notification-routing.cjs'));
const id=()=>randomBytes(16).toString('hex');const pause=ms=>new Promise(r=>setTimeout(r,ms));
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'relay-pop-integration-'));
const symbols=[];const register=(name,value)=>{const key=Symbol.for(name);symbols.push([key,globalThis[key]]);globalThis[key]=value;};
(async()=>{
 const sent=[],markers={},restores=[];
 for(const [kind,root,prefix,endpoint] of [['ios',ios,'SPOP','https://web.push.apple.com/test'],['and',and,'SPAND','https://fcm.googleapis.com/fcm/send/test']]){
  const {createCore,decode,encode}=require(path.join(root,kind,'server/core.cjs'));
  const {observe}=require(path.join(root,kind,'server/index.cjs'));
  const core=createCore({directory:path.join(dir,kind),send:async(_sub,data)=>sent.push({kind,payload:JSON.parse(data)})});
  const ec=createECDH('prime256v1');ec.generateKeys();
  const setup=decode(core.pairStart('alice').code,prefix+'1');
  const device=core.pairFinish('alice',encode({...setup,subscription:{endpoint,keys:{p256dh:ec.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}}},prefix+'2'));
  markers[kind]={v:1,clientId:id(),requestId:id(),generationId:id(),deviceId:device.id,type:'normal',enabled:true,translationEnabled:true,visible:false,backgroundOnly:true,ts:Date.now()};
  register('silly-pop.'+kind+'.translation-notifier.v1',{apiVersion:1,prepare:(owner,marker)=>core.prepareTranslation(owner,marker)});
  restores.push(observe(core));
 }
 const {createTranslationNotifier}=require(path.join(apk,'server-plugin/translation-notifier.cjs'));
 register('silly-pop.translation-notifier',createTranslationNotifier({getState:()=>null,send:async payload=>sent.push({kind:'apk',payload})}));
 markers.apk={protocol:1,clientId:'fixture',generationId:id(),type:'normal',translationEnabled:true,visibleAtRequest:false,backgroundOnly:true};
 const routing=createRouting(path.join(dir,'routing'));register('silly-relay.notification-routing.v1',routing);
 let translated=0,generated=0;const completions=[];
 const jobs=createJobs({engines:{verba:{createEngine:()=>({shouldTranslate:()=>true,output:async source=>{translated++;await pause(5);return{translation:'번역 '+source,sourceMap:[]};}})}},prepareNotification:(owner,marker,selected)=>prepareSelected(owner,selected)});
 register('verba.relay-observer',{apiVersion:1,complete:(owner,ticket,response)=>jobs.observed(owner,ticket,response),notificationTarget:(owner,ticket)=>jobs.lookup(owner,ticket).notificationTarget,translationNotification:(owner,ticket)=>jobs.lookup(owner,ticket).translationNotification,binding:(owner,ticket)=>({id:ticket,variant:'verba',config:jobs.lookup(owner,ticket).clientConfig})});
 const routes=[],relay=createRelay({routing,pollMs:10});
 relay.install(Object.fromEntries(['get','post'].map(method=>[method,(route,fn)=>routes.push({method:method.toUpperCase(),route,fn})])));
 const server=http.createServer(async(req,res)=>{
  res.status=code=>{res.statusCode=code;return res;};res.json=data=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(data));};
  req.user={profile:{handle:'alice'}};const chunks=[];for await(const c of req)chunks.push(c);req.body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
  const url=new URL(req.url,'http://localhost');req.query=Object.fromEntries(url.searchParams);
  if(url.pathname==='/api/backends/chat-completions/generate'){
   generated++;assert.equal(req.body.model,'custom-argon');
   setTimeout(()=>res.json({choices:[{message:{content:'Original reply'}}]}),20);return;
  }
  for(const r of routes){const names=[];const pattern=r.route.replace(/:([a-z]+)/g,(_,n)=>{names.push(n);return'([^/]+)';});const match=url.pathname.replace('/api/plugins/silly-relay','').match(new RegExp('^'+pattern+'$'));if(r.method===req.method&&match){req.params=Object.fromEntries(names.map((n,i)=>[n,match[i+1]]));return r.fn(req,res);}}
  res.status(404).json({error:'not found'});
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try {
  for(const target of ['ios','and','apk','none']){
   routing.set('alice',target);const ticket=id(),jobId=id();
   const candidates=structuredClone(markers);for(const m of Object.values(candidates)){m.generationId=id();m.requestId=id();}
   const job=jobs.start('alice',{id:ticket,kind:'observed-generation',snapshot:{variant:'verba',settings:{}},clientConfig:'fixture',notification:{routing:true,candidates},generation:{}},{});
   const response=await fetch(base+'/api/plugins/silly-relay/jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:jobId,path:'/api/backends/chat-completions/generate',body:JSON.stringify({model:'custom-argon',type:'normal',__verba_server_ticket:ticket,silly_pop_ios:candidates.ios,silly_pop_and:candidates.and})})});
   assert.equal(response.status,202);
   // No result GET/browser activity during generation or translation.
   routing.set('alice',target==='ios'?'and':'ios');
   await job.done;await job.notificationDone;await pause(10);
   assert.equal(job.state,'completed');assert.equal(job.result.translation,'번역 Original reply');
   const state=await(await fetch(base+'/api/plugins/silly-relay/jobs/'+jobId)).json();
   assert.equal(state.notificationTarget,target);assert.equal(state.translation.id,ticket);assert.equal(state.state,'completed');
   completions.push(state);
  }
  assert.deepEqual(sent.map(v=>v.kind),['ios','and','apk']);
  assert.ok(sent.every(v=>/번역이 완료/.test(v.payload.title)));
  assert.equal(translated,4);assert.equal(generated,4);assert.equal(completions.length,4);
  console.log('PASS: three installed notification targets, account selection, route snapshot, detached translation, original recovery, one generation/translation per request');
 } finally {relay.close();jobs.stopAll();server.closeAllConnections();await new Promise(r=>server.close(r));for(const restore of restores.reverse())restore();}
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{for(const [key,value]of symbols){if(value)globalThis[key]=value;else delete globalThis[key];}fs.rmSync(dir,{recursive:true,force:true});});
