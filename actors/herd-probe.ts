/** Bounded real Terse + native shared-world acceptance, followed by receipt-only runtime recovery. */
import {startLocalActors} from 'terse-sdk/dev';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {PhysicsWorker} from './world-physics';
import {HerdSession} from './herd-session';

const root=resolve(import.meta.dir,'..');
const allowed=new Set(['HOME','TMPDIR','PATH','LANG','RANGERS_WORLD_ACTOR_PORT']);
if(Object.keys(process.env).some(name=>!allowed.has(name))||process.env.HOME!==resolve(root,'.cache/world/home')||
  process.env.TMPDIR!==resolve(root,'.cache/world/tmp')||process.env.PATH!=='/usr/bin:/bin')throw new Error('Use the minimal isolated probe environment');
const port=Number(process.env.RANGERS_WORLD_ACTOR_PORT??7116);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid local probe port');
await new Promise<void>((ok,fail)=>{const p=createServer();p.once('error',fail);p.listen(port,'127.0.0.1',()=>p.close(e=>e?fail(e):ok()));});
const episode=crypto.randomUUID(),key=crypto.randomUUID()+crypto.randomUUID();
const ids=Array.from({length:4},(_,slot)=>`herd-${episode}-${slot}`);
const options={project:import.meta.dir,entrypoint:'src/herd-actor.ts',projectId:'ranger-herd',port,
  dataDir:resolve(root,'.cache/world/herd-proof',episode),apiKey:key,quiet:true};
let runtime:Awaited<ReturnType<typeof startLocalActors>>|undefined,session:HerdSession|undefined,timedOut=false;
async function start(){runtime=await startLocalActors(options);runtime.closed.catch(()=>{});}
async function rpc(id:string,method:string,args:unknown[]=[]){
  const response=await fetch(`${runtime!.connection.controlPlaneUrl}/v1/projects/ranger-herd/actors/HerdRanger/${id}/invoke`,{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(15000),
    body:JSON.stringify({requestId:crypto.randomUUID(),method,args})});
  if(!response.ok)throw new Error(`Herd RPC failed: ${method}`);
  const result=await response.json() as {outcome:{type:string;result:string}};
  if(result.outcome?.type!=='completed')throw new Error('Actor invocation did not complete');
  return JSON.parse(result.outcome.result);
}
const deadline=setTimeout(()=>{timedOut=true;void session?.shutdown();void runtime?.stop();},240000);
try {
  await start();
  const activations:string[]=[];
  for(let slot=0;slot<4;slot++)activations.push((await rpc(ids[slot],'initialize',[slot])).activation);
  session=new HerdSession(ids,()=>new PhysicsWorker(root,'herd'),rpc);
  await session.start();
  if(session.status!=='running')throw new Error(session.error);
  session.pause(true);const frozen=session.physics.tick;await session.tick();
  if(session.physics.tick!==frozen)throw new Error('Pause advanced physics');
  session.pause(false);
  while(!timedOut&&session.status==='running'&&session.physics.time<60)await session.tick(50);
  if(timedOut||session.snapshot().status!=='complete')throw new Error(session.error||'Four deliveries did not finish');
  const saved=session.owners.map(o=>JSON.stringify(o.record));
  await Bun.write(resolve(root,'.cache/world/evidence/herd-live-receipts.json'),JSON.stringify(session.snapshot(),null,2));
  await runtime!.stop();runtime=undefined;await start();
  for(let slot=0;slot<4;slot++){
    const inspected=await rpc(ids[slot],'inspect');
    if(inspected.activation===activations[slot]||JSON.stringify(inspected.delivery)!==saved[slot])
      throw new Error('A measured receipt did not survive a fresh actor activation');
  }
  console.log(JSON.stringify({passed:true,physicalRangers:4,durableActors:4,physicsWorlds:1,
    simulatedSeconds:session.physics.time,steps:session.physics.rangers.map((r:any)=>r.steps),
    placed:session.owners.map(o=>o.record?.status),receiptRestartVerified:true,physicsResumeVerified:false}));
} finally {clearTimeout(deadline);await session?.shutdown();await runtime?.stop();}
