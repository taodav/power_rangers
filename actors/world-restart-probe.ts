/** Bounded, real local-runtime probe. Run only with the minimal environment in VALIDATION.md. */
import {startLocalActors} from 'terse-sdk/dev';
import {resolve} from 'node:path';
import {createServer} from 'node:net';
import {RANGERS} from './src/world-policy';

const root=resolve(import.meta.dir,'..');
const allowed=new Set(['HOME','TMPDIR','PATH','LANG','RANGERS_WORLD_ACTOR_PORT']);
if(Object.keys(process.env).some(name=>!allowed.has(name)))throw new Error('Probe requires an explicit minimal environment');
if(process.env.HOME!==resolve(root,'.cache/world/home')||process.env.TMPDIR!==resolve(root,'.cache/world/tmp')||process.env.PATH!=='/usr/bin:/bin')throw new Error('Probe environment paths do not match the isolated fixture');
const port=Number(process.env.RANGERS_WORLD_ACTOR_PORT??7112);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid probe port');
await new Promise<void>((ok,fail)=>{const s=createServer();s.once('error',fail);s.listen(port,'127.0.0.1',()=>s.close(error=>error?fail(error):ok()));});
const episode=crypto.randomUUID(),key=crypto.randomUUID()+crypto.randomUUID();
const options={project:import.meta.dir,entrypoint:'src/world-actor.ts',projectId:'ranger-proof',port,
  dataDir:resolve(root,'.cache/world/probe-data',episode),apiKey:key,quiet:true};
let runtime:Awaited<ReturnType<typeof startLocalActors>>|undefined;
const ids=RANGERS.map((_,i)=>`proof-${episode}-${i}`);
async function start(){runtime=await startLocalActors(options);runtime.closed.catch(()=>{});}
async function call(id:string,method:string,args:unknown[]=[]){
  if(!runtime)throw new Error('Probe runtime is not started');
  const response=await fetch(`${runtime.connection.controlPlaneUrl}/v1/projects/ranger-proof/actors/WorldRanger/${id}/invoke`,{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},
    body:JSON.stringify({requestId:crypto.randomUUID(),method,args}),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error(`Probe RPC failed: ${method}, HTTP ${response.status}`);
  const data=await response.json() as {outcome:{type:string;result:string}};
  if(data.outcome?.type!=='completed')throw new Error(`Probe invocation did not complete: ${method}`);
  return JSON.parse(data.outcome.result);
}
function durable(memory:Record<string,unknown>){const {activation,...record}=memory;return JSON.stringify(record);}
let timedOut=false;
const deadline=setTimeout(()=>{timedOut=true;void runtime?.stop();},45000);
try {
  await start();const before:Record<string,unknown>[]=[],physicsBefore:Record<string,unknown>[]=[];
  for(let i=0;i<4;i++){
    await call(ids[i],'initialize',[i]);
    await call(ids[i],'decide',[JSON.stringify({epoch:1,sequence:1,mode:'assemble',x:0,z:0})]);
    await call(ids[i],'confirmDock',[1,...RANGERS[i].dock]);
    const claim=await call(ids[i],'decideBuild',[JSON.stringify({sequence:1,x:0,z:0,open:[{id:100+i,x:1,z:0,level:0,crew:1}]})]);
    if(claim.action!=='claim'||claim.slotId!==100+i)throw new Error('A Ranger did not claim a job for itself');
    await call(ids[i],'confirmPlaced',[1,100+i,'kinematic']);
    before.push(await call(ids[i],'inspect'));
    physicsBefore.push(await call(ids[i],'authorizePhysics',[JSON.stringify({sequence:1,swing:'left',tilt:3,leftContact:true,rightContact:true})]));
  }
  const deliveries:string[]=[];
  for(let i=0;i<4;i++){
    await call(ids[i],'authorizeDelivery',[JSON.stringify({jobId:`job-${i}`,slot:i,objectId:`box-${i}`,destination:[1,0,.5],tolerance:.05})]);
    deliveries.push(JSON.stringify(await call(ids[i],'recordPlacement',[JSON.stringify({jobId:`job-${i}`,objectId:`box-${i}`,evidence:'measured',released:true,supported:true,settled:true,position:[1,0,.51],simulationTime:12.5})])));
  }
  await runtime!.stop();runtime=undefined;await start();
  const after:Record<string,unknown>[]=[];for(const id of ids)after.push(await call(id,'inspect'));
  if(timedOut||before.some((m,i)=>durable(m)!==durable(after[i])))throw new Error('Durable record mismatch after runtime restart');
  if(after.some((m,i)=>m.activation===before[i].activation)||new Set(after.map(m=>m.activation)).size!==4)throw new Error('Probe did not observe four new actor activations');
  for(let i=0;i<4;i++)if(JSON.stringify(await call(ids[i],'inspectDelivery'))!==deliveries[i])throw new Error('A delivery receipt did not survive restart');
  for(let i=0;i<4;i++)if(JSON.stringify(await call(ids[i],'inspectPhysics'))!==JSON.stringify(physicsBefore[i]))throw new Error('Owned physics authorization did not survive restart');
  for(let i=0;i<4;i++){
    const next=await call(ids[i],'decide',[JSON.stringify({epoch:2,sequence:2,mode:'roam',x:0,z:0})]);
    if(next.sequence!==2||next.decisions!==2||next.docked)throw new Error('Restored actor could not continue its sequence');
    const claim=await call(ids[i],'decideBuild',[JSON.stringify({sequence:2,x:0,z:0,open:[]})]);
    if(claim.sequence!==2||claim.placed[0]?.slotId!==100+i||claim.placed[0]?.evidence!=='kinematic'||claim.action!=='idle')throw new Error('Restored actor lost its placement receipts');
  }
  console.log('PASS: 4 actor records, docking receipts, preview and delivery receipts, and owned physics plans survived a full local-runtime stop/start; 4 activations changed; all 4 continued with decision 2.');
} finally {clearTimeout(deadline);await runtime?.stop();}
