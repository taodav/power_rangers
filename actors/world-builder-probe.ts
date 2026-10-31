/** Live acceptance against an explicitly selected, otherwise idle local preview. No child processes. */
import {resolve} from 'node:path';

const root=resolve(import.meta.dir,'..');
const port=Number(process.env.RANGERS_WORLD_PORT??8772);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid preview port');
const origin=`http://127.0.0.1:${port}`;
const state=async()=>await(await fetch(origin+'/api/state',{signal:AbortSignal.timeout(5000)})).json() as any;
const command=(name:string,extra={})=>fetch(origin+'/api/command',{method:'POST',signal:AbortSignal.timeout(35000),
  headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({command:name,...extra})});
function check(ok:unknown,message:string):asserts ok {if(!ok)throw new Error(message);}
const initial=await state();
check(!initial.builder&&!initial.physics&&!initial.error,'Use a healthy idle preview, not another active episode');
check((await command('deliver',{objectId:'unknown',destinationId:'station-1'})).status===400,'Unknown object did not refuse');
let ownedJobId:string|null=null;
try {
  const started=await command('deliver',{objectId:'cargo-0',destinationId:'station-1'});
  check(started.ok,'Delivery start failed');
  let current=await state();const {jobId,actorId}=current.builder;
  ownedJobId=jobId;
  check(current.builder.actorRecord.status==='authorized','Intent was not saved before motion');
  check((await command('assemble')).status===400,'Mode switch during delivery did not refuse');
  check((await command('deliver',{objectId:'cargo-0',destinationId:'station-1'})).status===400,'Duplicate delivery did not refuse');
  check((await command('pause')).ok,'Pause failed');
  const paused=await state();await Bun.sleep(300);current=await state();
  check(current.builder.status==='paused'&&current.builder.physics.tick===paused.builder.physics.tick,'Pause did not freeze physics');
  check((await command('pause')).ok,'Resume failed');
  const deadline=Date.now()+90000;
  while(Date.now()<deadline){
    current=await state();
    check(current.builder.jobId===jobId&&current.builder.actorId===actorId,'Job identity changed');
    check(current.builder.status!=='error',current.builder.error);
    if(current.builder.status==='complete')break;
    await Bun.sleep(100);
  }
  check(current.builder.status==='complete','Delivery did not finish within 90 seconds');
  check(current.builder.actorRecord.status==='placed','Actor did not save placement');
  check(current.builder.physics.objects[0].placed&&current.builder.physics.objects[0].held_by===null,'Object was not released');
  check(!current.physics,'Builder reused combined-rig state');
  await Bun.write(resolve(root,'.cache/world/evidence/live-builder-receipt.json'),JSON.stringify(current.builder,null,2));
  console.log(JSON.stringify({passed:true,simulationTime:current.builder.physics.time,steps:current.builder.physics.steps,
    status:current.builder.status,supportForce:current.builder.actorRecord.receipt.support_force}));
} finally {
  if(ownedJobId&&(await state()).builder?.jobId===ownedJobId){
    const stopped=await command('builder-stop');
    check(stopped.ok,'Explicit stop failed; the episode remains latched for reconciliation');
    check(!(await state()).builder,'Stop did not return to the city preview');
  }
}
