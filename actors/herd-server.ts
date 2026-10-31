/** V3 API: exactly four durable owners and one authoritative shared-physics worker. */
import {startLocalActors} from 'terse-sdk/dev';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {HerdSession} from './herd-session';
import {PhysicsWorker} from './world-physics';
import {RANGERS} from './src/world-policy';

const root=resolve(import.meta.dir,'..');
const port=Number(process.env.RANGERS_WORLD_PORT??8775),actorPort=Number(process.env.RANGERS_WORLD_ACTOR_PORT??7116);
if(![port,actorPort].every(p=>Number.isInteger(p)&&p>=1024&&p<=65535)||port===actorPort)throw new Error('Invalid local ports');
for(const p of [port,actorPort])await new Promise<void>((ok,fail)=>{const probe=createServer();probe.once('error',fail);probe.listen(p,'127.0.0.1',()=>probe.close(e=>e?fail(e):ok()));});
const run=crypto.randomUUID(),key=crypto.randomUUID()+crypto.randomUUID();
const ids=RANGERS.map((_,slot)=>`herd-${run}-${slot}`);
const runtime=await startLocalActors({project:import.meta.dir,entrypoint:'src/herd-actor.ts',projectId:'ranger-herd',port:actorPort,
  dataDir:resolve(root,`.cache/world/herd-actors-${actorPort}`),apiKey:key,quiet:true});
let herd:HerdSession|null=null,commandBusy=false,tickBusy:Promise<void>|null=null,error='',eventId=0;
let events:{id:number;time:number;slot:number;kind:string;text:string}[]=[];
const event=(slot:number,kind:string,text:string)=>{events=[...events.slice(-119),{id:++eventId,time:herd?.physics?.time??0,slot,kind,text}];};
async function rpc(id:string,method:string,args:unknown[]){
  const response=await fetch(`${runtime.connection.controlPlaneUrl}/v1/projects/ranger-herd/actors/HerdRanger/${id}/invoke`,{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(30000),
    body:JSON.stringify({requestId:crypto.randomUUID(),method,args})});
  if(!response.ok)throw new Error('A durable actor call failed');
  const responseBody=await response.json() as {outcome:{type:string;result:string}};
  if(responseBody.outcome?.type!=='completed')throw new Error('A durable actor call did not complete');
  return JSON.parse(responseBody.outcome.result);
}
try {for(let slot=0;slot<4;slot++)await rpc(ids[slot],'initialize',[slot]);}
catch(e){await runtime.stop();throw e;}
event(-1,'system','Four durable Ranger owners ready. Start a shared physical delivery round.');

function tick(){
  if(!herd||tickBusy||commandBusy||error||herd.status!=='running')return;
  const current=herd,previous=current.physics;
  tickBusy=current.tick(5).then(()=>{
    for(let slot=0;slot<4;slot++){
      const before=previous.rangers[slot],after=current.physics.rangers[slot];
      if(after.job!==before.job)event(slot,'physics',`${RANGERS[slot].name}: ${after.job.replaceAll('_',' ')}.`);
      if(after.steps>before.steps)event(slot,'physics',`Measured footstep ${after.steps}; ${after.forward.toFixed(2)} m forward.`);
      if(after.manipulation_receipts.length>before.manipulation_receipts.length)
        for(const receipt of after.manipulation_receipts.slice(before.manipulation_receipts.length))event(slot,'measurement',`Measured ${receipt.event.replaceAll('_',' ')} for ${receipt.object_id}.`);
    }
    if(current.status==='complete')event(-1,'delivery','All four actors saved their own measured placement receipts. Shared native episode ended.');
    if(current.status==='error')event(-1,'error',current.error);
  }).finally(()=>tickBusy=null);
}
async function command(name:string){
  if(commandBusy)throw new Error('Another command is completing');
  commandBusy=true;
  try {
    await tickBusy;
    if(name==='herd-stop'){
      if(!herd)throw new Error('No shared episode exists');
      await herd.stop();herd=null;event(-1,'system','Shared episode stopped. No physical state will be silently resumed.');return;
    }
    if(error)throw new Error('Restart after the runtime error');
    if(name==='pause'){
      if(!herd||!['running','paused'].includes(herd.status))throw new Error('Pause is available during a live episode');
      herd.pause(herd.status==='running');event(-1,'system',herd.status==='paused'?'All four physical clocks paused.':'Shared physics resumed.');return;
    }
    if(name!=='herd-deliver'||herd)throw new Error('Start only from an idle shared world');
    herd=new HerdSession(ids,()=>new PhysicsWorker(root,'herd'),rpc);
    await herd.start();
    if(herd.error){event(-1,'error',herd.error);throw new Error(herd.error);}
    for(const owner of herd.owners)event(owner.slot,'intent',`${RANGERS[owner.slot].name} saved its own delivery intent. Four-actor start barrier passed.`);
  } finally {commandBusy=false;}
}
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const server=Bun.serve({hostname:'127.0.0.1',port,maxRequestBodySize:512,async fetch(request){
  const url=new URL(request.url);
  if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(request.headers.get('Host')??''))return json({error:'Local host only'},403);
  if(request.method==='GET'&&url.pathname==='/api/state')return json({run,rangers:RANGERS,actorIds:ids,herd:herd?.snapshot()??null,events,error,
    paused:herd?.status==='paused',inflight:Number(commandBusy)+Number(!!tickBusy),control:'Four Terse owners · one shared MuJoCo world',
    boundary:'Four fixed delivery workspaces. Shared building, navigation, physical combination and whole-world recovery are not implemented.'});
  if(request.method==='GET'&&url.pathname==='/')return json({status:'V3 physics API ready',state:'/api/state',ui:'Not integrated yet; use the stable demo for the current interface.'});
  if(request.method!=='POST'||url.pathname!=='/api/command')return json({error:'Not found'},404);
  if(![`http://127.0.0.1:${port}`,`http://localhost:${port}`].includes(request.headers.get('Origin')??''))return json({error:'Same-origin command required'},403);
  if(request.headers.get('Content-Type')!=='application/json')return json({error:'Small JSON required'},400);
  try {const body=await request.text();if(body.length>512)throw new Error('Command too large');await command(JSON.parse(body).command);return json({ok:true});}
  catch(e){return json({error:e instanceof Error?e.message:'Invalid command'},400);}
}});
const interval=setInterval(tick,50);
let stopping=false;
async function stop(){if(stopping)return;stopping=true;clearInterval(interval);server.stop(true);await tickBusy;await herd?.shutdown();await runtime.stop();process.exit(0);}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
runtime.closed.catch(()=>{error='Terse disconnected. Shared physics stopped; do not replay uncertain work.';event(-1,'error',error);void herd?.shutdown();});
console.log(`V3 herd API: http://127.0.0.1:${port} (four local Terse actors on :${actorPort})`);
