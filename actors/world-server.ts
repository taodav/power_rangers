/** One world writer; four durable planners, with mutually exclusive native episodes. */
import {startLocalActors} from "terse-sdk/dev";
import {createServer} from "node:net";
import {resolve} from "node:path";
import {World} from "./world-engine";
import {RANGERS} from "./src/world-policy";
import {PhysicsWorker} from "./world-physics";
import {PhysicalBuilder} from "./world-builder";
import {Construction,canBuild,type BuildRequest} from "./world-construction";

const root=resolve(import.meta.dir,"..");
const port=Number(process.env.RANGERS_WORLD_PORT??8771), actorPort=Number(process.env.RANGERS_WORLD_ACTOR_PORT??7111);
if(![port,actorPort].every(p=>Number.isInteger(p)&&p>=1024&&p<=65535)||port===actorPort)throw new Error("Invalid local ports");
async function requireFree(port:number) {
  await new Promise<void>((ok,fail)=>{const probe=createServer();probe.once("error",fail);probe.listen(port,"127.0.0.1",()=>probe.close(e=>e?fail(e):ok()));});
}
await requireFree(port);await requireFree(actorPort);
const key=crypto.randomUUID()+crypto.randomUUID(); // Scoped local credential, never logged or saved.
const runtime=await startLocalActors({project:import.meta.dir,entrypoint:"src/world-actor.ts",projectId:"ranger-world",
  port:actorPort,dataDir:resolve(root,`.cache/world/actors-${actorPort}`),apiKey:key,quiet:true});
const world=new World(), inflight=new Map<number,Promise<void>>();
world.physicsAvailable=await Bun.file(resolve(root,'.venv/bin/python')).exists();
let physicsWorker:PhysicsWorker|null=null,physicsBusy:Promise<void>|null=null,commandBusy=false;
let builder:PhysicalBuilder|null=null,builderBusy:Promise<void>|null=null;
async function rpc(id:string,method:string,args:unknown[]) {
  const response=await fetch(`${runtime.connection.controlPlaneUrl}/v1/projects/ranger-world/actors/WorldRanger/${id}/invoke`,{
    method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${key}`},
    body:JSON.stringify({requestId:crypto.randomUUID(),method,args}),signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error(`Actor ${method} failed (HTTP ${response.status}); no automatic replay`);
  const envelope=await response.json() as {outcome:{type:string;result:string}};
  if(envelope.outcome?.type!=="completed")throw new Error(`Actor ${method} did not complete`);
  return JSON.parse(envelope.outcome.result);
}
try {
  for(const bot of world.bots) {const memory=await rpc(bot.id,"initialize",[bot.slot]);bot.activation=memory.activation;bot.status="planning";}
} catch(error) {await runtime.stop();throw error;}

function work(slot:number) {
  if(inflight.has(slot)||world.error||world.paused)return;
  const bot=world.bots[slot],epoch=world.epoch;
  if(bot.needsPlan) {
    bot.needsPlan=false;bot.status="planning";
    const mode=world.phase==="roaming"?"roam":"assemble";
    const request=JSON.stringify({epoch,sequence:bot.sequence+1,mode,x:bot.x,z:bot.z});
    const promise=(async()=>{
      const memory=await rpc(bot.id,"decide",[request]);
      bot.sequence=memory.sequence;bot.decisions=memory.decisions;
      if(world.epoch!==epoch){bot.needsPlan=true;return;}
      bot.target=memory.target;bot.docked=false;
      world.event(slot,"plan",`${RANGERS[slot].name} chose ${mode==="roam"?"a patrol waypoint":"its docking waypoint"}. Decision ${memory.decisions} saved in Terse.`);
    })().catch(()=>{world.error="A Ranger decision has an uncertain outcome. Restart this world; do not guess or replay.";world.event(slot,"error",world.error);}).finally(()=>inflight.delete(slot));
    inflight.set(slot,promise);
  } else if(bot.status==="confirming") {
    const promise=(async()=>{
      await rpc(bot.id,"confirmDock",[bot.sequence,bot.x,bot.z]);
      if(world.epoch!==epoch)return;
      bot.docked=true;bot.status="docked";
      world.event(slot,"dock",`${RANGERS[slot].name} confirmed proximity and saved its docking receipt.`);
    })().catch(()=>{world.error="Docking confirmation failed. The assembly barrier remains closed.";world.event(slot,"error",world.error);}).finally(()=>inflight.delete(slot));
    inflight.set(slot,promise);
  }
}

const site=new Construction(),siteInflight=new Set<Promise<void>>();
function tickSite() {
  if(world.paused||world.error)return;
  site.step(.05,canBuild(world),world.bots,(slot,kind,text)=>world.event(slot,kind,text));
  for(const request of site.takeRequests()){
    const promise:Promise<void>=rpc(world.bots[request.slot].id,request.method,request.args)
      .then(memory=>site.receipt(request as BuildRequest,memory))
      .catch(()=>{world.error='A build decision has an uncertain outcome. Restart this world; do not guess or replay.';world.event(request.slot,'error',world.error);})
      .finally(()=>siteInflight.delete(promise));
    siteInflight.add(promise);
  }
}

async function physicsTick() {
  if(!physicsWorker||!world.physics||physicsBusy||commandBusy||world.paused||world.error)return;
  const worker=physicsWorker;
  physicsBusy=(async()=>{
    const previous=world.physics;
    if(previous.awaiting_actors){
      if(previous.forward>=2.5){world.patrol=false;world.physics=await worker.call({command:'mode',walking:false});world.event(-1,'physics','Reached the bounded straight-walk runway. Separate to start a fresh trial.');return;}
      const plans=await Promise.all(world.bots.map(async bot=>{
        const input=JSON.stringify({sequence:bot.physicsSequence+1,swing:previous.next_swing,tilt:previous.max_tilt_deg,
          leftContact:previous.contacts.left,rightContact:previous.contacts.right});
        const receipt=await rpc(bot.id,'authorizePhysics',[input]);
        bot.physicsSequence=receipt.sequence;bot.status=receipt.plan.action;
        world.event(bot.slot,'physics',`${RANGERS[bot.slot].name} saved joint plan ${receipt.sequence}: ${receipt.plan.action}.`);
        return receipt.plan;
      }));
      world.physics=await worker.call({command:'authorize',plans});
    } else {
      world.physics=await worker.call({command:'step',ticks:5});
      world.time+=world.physics.time-previous.time;
      if(world.physics.steps>previous.steps)world.event(-1,'physics',`MuJoCo confirmed step ${world.physics.steps}; ${world.physics.forward.toFixed(2)} m measured forward travel.`);
    }
    if(world.physics.failed)throw new Error(`MuJoCo stopped: ${world.physics.failed}`);
    const [x,y]=world.physics.body;
    world.core.x=y*2.4;world.core.z=x*2.4;world.core.distance=world.physics.forward*2.4;
  })().catch(async error=>{world.error=error instanceof Error?error.message:'Native physics failed';world.event(-1,'error',world.error);await worker.stop();if(physicsWorker===worker)physicsWorker=null;}).finally(()=>physicsBusy=null);
}

function builderTick(){
  if(!builder||builderBusy||world.paused||world.error)return;
  const current=builder,before=current.physics?.time??0;
  builderBusy=current.tick().then(()=>{world.time+=Math.max(0,(current.physics?.time??before)-before);}).finally(()=>builderBusy=null);
}

async function command(name:string,data:Record<string,unknown>={}) {
  if(commandBusy)throw new Error('Another command is still completing');
  commandBusy=true;
  try {
    await physicsBusy;
    await builderBusy;
    if(name==='builder-stop'){
      if(!builder)throw new Error('No physical builder episode is active');
      await builder.stop();builder=null;world.paused=false;
      world.bots.forEach(bot=>{bot.target=null;bot.speed=0;bot.needsPlan=true;});
      world.event(0,'physics','Native builder episode closed. Returning to the explicitly kinematic city preview.');return;
    }
    if(builder){
      if(name!=='pause')throw new Error('Stop the builder episode before changing modes');
      world.command('pause');builder.pause(world.paused);return;
    }
    if(name==='deliver'){
      if(data.objectId!=='cargo-0'||data.destinationId!=='station-1')throw new Error('Only cargo-0 to station-1 is available in this physical bench');
      if(world.phase!=='roaming'||physicsWorker||world.physics||world.error)throw new Error('Return to a healthy independent world first');
      if(!world.physicsAvailable)throw new Error('Install the repo-local physics requirements first');
      await Promise.all([...inflight.values(),...siteInflight]);
      if(world.error)throw new Error('An earlier actor decision needs reconciliation');
      site.step(.05,false,world.bots,(slot,kind,text)=>world.event(slot,kind,text));
      world.bots.forEach(bot=>{bot.target=null;bot.speed=0;bot.needsPlan=false;});
      world.paused=false;
      builder=new PhysicalBuilder(world.bots[0].id,()=>new PhysicsWorker(root,'ranger'),rpc,text=>world.event(0,'physics',text));
      await builder.start();
      if(builder.error)throw new Error(builder.error);
      world.time+=builder.physics.time;return;
    }
    if(name==='rebuild'){if(!site.complete)throw new Error('The structure is not finished yet');site.rebuild();world.event(-1,'build','New job started.');return;}
    if(name==='patrol'){
      if(world.phase!=='combined'||world.error)throw new Error('Assemble a healthy team first');
      if(!physicsWorker){
        if(!world.physicsAvailable)throw new Error('Install the repo-local physics requirements first');
        physicsWorker=new PhysicsWorker(root);
        try {
          for(let i=0;i<3;i++)world.physics=await physicsWorker.call({command:'step',ticks:50});
          if(world.physics.failed)throw new Error('The native rig did not settle safely');
        } catch(error) {await physicsWorker.stop();physicsWorker=null;world.error='Native rig initialization failed; no scripted motion was substituted.';throw error;}
        world.time+=world.physics.time;
        world.event(-1,'physics','Native MuJoCo rig engaged: a free body, ground contacts, and joint motors. Assembly remains a visual prototype.');
      }
      world.command(name);world.physics=await physicsWorker.call({command:'mode',walking:world.patrol});
    } else {
      if(name==='separate'&&physicsWorker){await physicsWorker.stop();physicsWorker=null;world.physics=null;world.event(-1,'assembly','Leaving the physical rig. Separation still uses the visual assembly rails.');}
      world.command(name);
    }
  } finally {commandBusy=false;}
}

const assets:Record<string,string>={"/":"world/index.html","/world.js":"world/world.js","/city-plan.js":"world/city-plan.js","/city.js":"world/city.js","/site-plan.js":"world/site-plan.js","/construction.js":"world/construction.js","/views.js":"world/views.js","/city.css":"world/city.css","/robots.js":"world/robots.js","/style.css":"world/style.css",
  "/vendor/three.module.js":"node_modules/three/build/three.module.js","/vendor/three.core.js":"node_modules/three/build/three.core.js",
  "/vendor/OrbitControls.js":"node_modules/three/examples/jsm/controls/OrbitControls.js"};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
const server=Bun.serve({hostname:"127.0.0.1",port,maxRequestBodySize:512,async fetch(request){
  const url=new URL(request.url);
  if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(request.headers.get("Host")??""))return json({error:"Local host only"},403);
  if(request.method==="GET") {
    if(url.pathname==="/api/state")return json({...world.snapshot(),inflight:inflight.size+siteInflight.size+Number(!!physicsBusy)+Number(!!builderBusy),rangers:RANGERS,site:site.snapshot(),builder:builder?.snapshot()??null,
      ...(builder?{control:'One Terse delivery actor · numeric MuJoCo skill',boundary:'One physical Ranger in a separate delivery episode. City preview suspended; four-robot physics and full-world recovery remain future work.'}:{})});
    const path=assets[url.pathname];if(!path)return json({error:"Not found"},404);
    const file=Bun.file(resolve(root,path));if(!await file.exists())return json({error:"Asset missing"},404);
    return new Response(file,{headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
  }
  if(request.method!=="POST"||url.pathname!=="/api/command")return json({error:"Not found"},404);
  if(![`http://127.0.0.1:${port}`,`http://localhost:${port}`].includes(request.headers.get("Origin")??""))return json({error:"Same-origin command required"},403);
  if(request.headers.get("Content-Type")!=="application/json"||Number(request.headers.get("Content-Length"))>512)return json({error:"Small JSON command required"},400);
  try {const text=await request.text();if(text.length>512)throw new Error("Command too large");const data=JSON.parse(text);await command(data.command,data);return json({ok:true});}
  catch(error){return json({error:error instanceof Error?error.message:"Invalid command"},400);}
}});
const interval=setInterval(()=>{if(commandBusy)return;if(builder){builderTick();return;}if(world.physics){void physicsTick();return;}world.step(.05);tickSite();world.bots.forEach(b=>work(b.slot));},50);
let stopping=false;
async function stop(){if(stopping)return;stopping=true;clearInterval(interval);server.stop(true);await builderBusy;await builder?.shutdown();await physicsBusy;await physicsWorker?.stop();await Promise.allSettled([...inflight.values(),...siteInflight]);await runtime.stop();process.exit(0);}
process.on("SIGINT",stop);process.on("SIGTERM",stop);
runtime.closed.catch(()=>{world.error="Local Terse runtime disconnected; world stopped.";world.event(-1,"error",world.error);});
console.log(`Ranger World: http://127.0.0.1:${port} (local Terse :${actorPort})`);
