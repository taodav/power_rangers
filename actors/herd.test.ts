import {test,expect,mock} from 'bun:test';
import {authorizeHerd,confirmHerd,HERD_STATIONS} from './src/herd-policy';
import {cancel,type DeliveryRecord} from './src/delivery-policy';
import {HerdSession} from './herd-session';
import type {NativeWorker} from './world-builder';

const request=(slot:number)=>({sequence:1,jobId:`test-${slot}`,ownerSlot:slot,objectId:`cargo-${slot}`,destinationId:`station-${slot+1}`,nativeReady:true});
function receipt(slot:number,jobId:string,tick=200){return {event:'placed',job_id:jobId,object_id:`cargo-${slot}`,owner_slot:slot,destination_id:`station-${slot+1}`,
  tick,time:tick*.01,evidence:'measured',settled_samples:50,position:HERD_STATIONS[`station-${slot+1}`],target:HERD_STATIONS[`station-${slot+1}`],
  support_force:1.18,linear_speed:0,tilt_deg:0,fingers_open:true,robot_contact:false,positioned:true,valid:true};}

test('four policies own distinct cargo and fixed physical destinations',()=>{
  expect(new Set(Object.values(HERD_STATIONS).map(position=>JSON.stringify(position))).size).toBe(4);
  for(let slot=0;slot<4;slot++){
    const r=request(slot),record=authorizeHerd(null,slot,JSON.stringify(r));
    expect(confirmHerd(record,r.jobId,JSON.stringify(receipt(slot,r.jobId))).status).toBe('placed');
    expect(()=>authorizeHerd(null,slot,JSON.stringify({...r,objectId:`cargo-${(slot+1)%4}`}))).toThrow();
    expect(()=>authorizeHerd(null,slot,JSON.stringify({...r,destinationId:`station-${(slot+1)%4+1}`}))).toThrow();
    expect(()=>confirmHerd(record,r.jobId,JSON.stringify({...receipt(slot,r.jobId),target:[0,0,0],position:[0,0,0]}))).toThrow();
  }
});

function fixture(failActor=-1,wrongReceipt=false){
  const trace:string[]=[],records:(DeliveryRecord|null)[]=Array(4).fill(null);
  let tick=0,jobs:any[]=[],stopped=false;
  const state=()=>({tick,time:tick*.01,physics_time:tick*.01,failed:'',authorized:jobs.length===4,complete:jobs.length===4,
    rangers:Array.from({length:4},(_,slot)=>({job:jobs.length?'complete':'idle',job_id:jobs[slot]?.jobId,
      manipulation_receipts:jobs.length?[{...receipt(slot,jobs[slot].jobId,tick),...(wrongReceipt&&slot===2?{owner_slot:1}:{})}]:[],
      objects:[{id:`cargo-${slot}`,placed:true,held_by:null}],placement:{valid:true}}))});
  const worker:NativeWorker={async call(command){trace.push(`native:${command.command}`);
    if(command.command==='step')tick+=command.ticks as number;
    if(command.command==='authorize')jobs=command.jobs as any[];return state();},async stop(){stopped=true;}};
  const rpc=async(id:string,method:string,args:unknown[])=>{
    const slot=Number(id.slice(-1));trace.push(`${slot}:${method}`);
    if(method==='inspectDelivery')return records[slot]??{};
    if(method==='authorizeDelivery'){
      if(slot===failActor)throw new Error('Synthetic uncertain authorization');
      records[slot]=authorizeHerd(records[slot],slot,args[0] as string);
    }
    if(method==='confirmDelivery')records[slot]=confirmHerd(records[slot],args[0] as string,args[1] as string);
    if(method==='cancelDelivery')records[slot]=cancel(records[slot],args[0] as string);
    return records[slot];
  };
  return {session:new HerdSession(['actor-0','actor-1','actor-2','actor-3'],()=>worker,rpc),trace,records,get stopped(){return stopped;}};
}

test('all four saved intents precede the single native start; four measured receipts complete',async()=>{
  const f=fixture();await f.session.start();expect(f.session.status).toBe('running');
  for(let slot=0;slot<4;slot++)expect(f.trace.indexOf(`${slot}:authorizeDelivery`)).toBeLessThan(f.trace.indexOf('native:authorize'));
  f.session.pause(true);await f.session.tick();expect(f.session.physics.tick).toBe(150);
  f.session.pause(false);await f.session.tick(50);
  expect(f.session.status).toBe('complete');expect(f.records.map(r=>r?.status)).toEqual(Array(4).fill('placed'));expect(f.stopped).toBe(true);
  await expect(f.session.start()).rejects.toThrow();
});

test('one uncertain owner prevents ALL native motion; explicit stop reconciles partial intents',async()=>{
  const f=fixture(2);await f.session.start();expect(f.session.status).toBe('error');
  expect(f.trace).not.toContain('native:authorize');expect(f.stopped).toBe(true);
  expect(f.records.filter(Boolean)).toHaveLength(3);await f.session.stop();
  expect(f.records.filter(Boolean).every(r=>r?.status==='cancelled')).toBe(true);
});

test('a foreign receipt stops the world without promoting that owner to placed',async()=>{
  const f=fixture(-1,true);await f.session.start();await f.session.tick(50);
  expect(f.session.status).toBe('error');expect(f.records[2]?.status).toBe('authorized');expect(f.stopped).toBe(true);
});

mock.module('terse-sdk/actor',()=>({Actor:class {id='synthetic-actor';},Persisted:()=>{},Ephemeral:()=>{}}));
const {HerdRanger}=await import('./src/herd-actor');
test('actor initialization is immutable and delivery records are independent (mock SDK)',async()=>{
  const actors=Array.from({length:4},()=>new (HerdRanger as any)());
  await expect(actors[0].authorizeDelivery(JSON.stringify(request(0)))).rejects.toThrow();
  for(let slot=0;slot<4;slot++){
    await actors[slot].initialize(slot);
    await expect(actors[slot].initialize((slot+1)%4)).rejects.toThrow();
    await actors[slot].authorizeDelivery(JSON.stringify(request(slot)));
    await actors[slot].confirmDelivery(`test-${slot}`,JSON.stringify(receipt(slot,`test-${slot}`)));
  }
  expect(new Set(await Promise.all(actors.map(async actor=>JSON.parse(await actor.inspectDelivery()).jobId))).size).toBe(4);
});
