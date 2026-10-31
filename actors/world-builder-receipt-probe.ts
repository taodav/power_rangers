/** Read the actual live-builder receipt across a full local Terse restart, never replaying motion. */
import {startLocalActors} from 'terse-sdk/dev';
import {createServer} from 'node:net';
import {resolve} from 'node:path';

const root=resolve(import.meta.dir,'..');
const allowed=new Set(['HOME','TMPDIR','PATH','LANG','RANGERS_WORLD_ACTOR_PORT']);
if(Object.keys(process.env).some(name=>!allowed.has(name))||process.env.HOME!==resolve(root,'.cache/world/home')||
  process.env.TMPDIR!==resolve(root,'.cache/world/tmp')||process.env.PATH!=='/usr/bin:/bin')throw new Error('Use the documented minimal environment');
const port=Number(process.env.RANGERS_WORLD_ACTOR_PORT);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Explicitly select the stopped validation runtime port');
await new Promise<void>((ok,fail)=>{const p=createServer();p.once('error',fail);p.listen(port,'127.0.0.1',()=>p.close(e=>e?fail(e):ok()));});
const evidence=await Bun.file(resolve(root,'.cache/world/evidence/live-builder-receipt.json')).json();
if(!/^world-[a-f0-9-]{36}-0$/.test(evidence.actorId)||evidence.actorRecord?.status!=='placed'||
  evidence.actorRecord?.receipt?.evidence!=='measured')throw new Error('A successful live-builder probe is required first');
const key=crypto.randomUUID()+crypto.randomUUID();
const options={project:import.meta.dir,entrypoint:'src/world-actor.ts',projectId:'ranger-world',port,
  dataDir:resolve(root,`.cache/world/actors-${port}`),apiKey:key,quiet:true};
let runtime:Awaited<ReturnType<typeof startLocalActors>>|undefined,timedOut=false;
async function start(){runtime=await startLocalActors(options);runtime.closed.catch(()=>{});}
async function inspect(method:string){
  const response=await fetch(`${runtime!.connection.controlPlaneUrl}/v1/projects/ranger-world/actors/WorldRanger/${evidence.actorId}/invoke`,{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(10000),
    body:JSON.stringify({requestId:crypto.randomUUID(),method,args:[]})});
  if(!response.ok)throw new Error('Saved receipt inspection failed');
  const value=await response.json() as {outcome:{type:string;result:string}};
  if(value.outcome?.type!=='completed')throw new Error('Inspection did not complete');
  return JSON.parse(value.outcome.result);
}
const deadline=setTimeout(()=>{timedOut=true;void runtime?.stop();},45000);
try {
  await start();
  const activation=(await inspect('inspect')).activation;
  if(JSON.stringify(await inspect('inspectDelivery'))!==JSON.stringify(evidence.actorRecord))throw new Error('Live receipt was not restored');
  await runtime!.stop();runtime=undefined;await start();
  if(timedOut||(await inspect('inspect')).activation===activation)throw new Error('A fresh activation was not observed');
  if(JSON.stringify(await inspect('inspectDelivery'))!==JSON.stringify(evidence.actorRecord))throw new Error('Receipt changed across restart');
  console.log('PASS: the actual measured live delivery receipt survived a full Terse stop/start with a fresh actor activation. No physics was resumed.');
} finally {clearTimeout(deadline);await runtime?.stop();}
