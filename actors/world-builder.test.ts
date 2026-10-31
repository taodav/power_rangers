import {test,expect} from 'bun:test';
import {PLAYBACK,PhysicalBuilder,type NativeWorker} from './world-builder';
import {authorize,confirm,cancel,type DeliveryRecord} from './src/delivery-policy';

// Synthetic adapter controls. Native motion and real actor persistence have separate integration checks.
function fixture(options:{badReceipt?:Record<string,unknown>;rpcFailure?:string;nativeFailure?:boolean;prior?:boolean}={}) {
  const trace:string[]=[],events:string[]=[];
  let record:DeliveryRecord|null=null,tick=0,jobId='',stopped=false;
  const base=()=>({tick,time:tick*.01,job:jobId?'approach':'idle',job_id:jobId||null,steps:0,forward:0,failed:'',manipulation_receipts:[]});
  const worker:NativeWorker={
    async call(command){
      trace.push(`native:${command.command}`);
      if(command.command==='deliver'){jobId=command.jobId as string;return base();}
      tick+=command.ticks as number;
      if(!jobId)return base();
      const receipt={event:'placed',job_id:jobId,object_id:'cargo-0',owner_slot:0,destination_id:'station-1',tick,time:tick*.01,
        evidence:'measured',settled_samples:50,position:[.93,.83,.99],target:[.93,.83,.99],support_force:1.18,linear_speed:0,
        tilt_deg:0,fingers_open:true,robot_contact:false,positioned:true,valid:true,...options.badReceipt};
      return {...base(),job:'complete',failed:options.nativeFailure?'synthetic failure':'',manipulation_receipts:[receipt],
        placement:{valid:true},objects:[{id:'cargo-0',placed:true,held_by:null}]};
    },
    async stop(){stopped=true;trace.push('native:stop');}
  };
  const rpc=async(id:string,method:string,args:unknown[])=>{
    expect(id).toBe('ember-fixture');trace.push(method);
    if(method===options.rpcFailure)throw new Error('Synthetic RPC uncertainty');
    if(method==='inspectDelivery')return options.prior?{status:'authorized',jobId:'older-job',sequence:1}:record??{};
    if(method==='authorizeDelivery')record=authorize(record,0,args[0] as string);
    if(method==='confirmDelivery')record=confirm(record,args[0] as string,args[1] as string);
    if(method==='cancelDelivery')record=cancel(record,args[0] as string);
    return record;
  };
  const builder=new PhysicalBuilder('ember-fixture',()=>{trace.push('native:create');return worker;},rpc,text=>events.push(text));
  return {builder,trace,events,get record(){return record;},get stopped(){return stopped;}};
}

test('durable intent precedes motion; complete requires the saved measured receipt',async()=>{
  const f=fixture();await f.builder.start();
  expect(f.builder.status).toBe('running');
  expect(f.trace.indexOf('authorizeDelivery')).toBeLessThan(f.trace.indexOf('native:deliver'));
  expect(f.record?.status).toBe('authorized');
  await f.builder.tick();
  expect(f.builder.status).toBe('complete');expect(f.record?.status).toBe('placed');expect(f.stopped).toBe(true);
  const saved=JSON.stringify(f.record);await f.builder.stop();expect(JSON.stringify(f.record)).toBe(saved);
  expect(f.trace.filter(m=>m==='confirmDelivery')).toHaveLength(1);
  await f.builder.tick();expect(f.trace.filter(m=>m==='confirmDelivery')).toHaveLength(1);
  await expect(f.builder.start()).rejects.toThrow('cannot be replayed');
});

test('faster playback runs more physics per call and reports its speed',async()=>{
  const f=fixture();await f.builder.start();const before=f.builder.physics.tick;
  expect(f.builder.snapshot().playback).toBe(PLAYBACK);expect(PLAYBACK).toBe(3);
  await f.builder.tick();expect(f.builder.physics.tick-before).toBe(5*PLAYBACK);
});

test('pause freezes ticks; resume continues the same job',async()=>{
  const f=fixture();await f.builder.start();const tick=f.builder.physics.tick,id=f.builder.jobId;
  f.builder.pause(true);await f.builder.tick();await f.builder.tick();
  expect(f.builder.status).toBe('paused');expect(f.builder.physics.tick).toBe(tick);
  f.builder.pause(false);await f.builder.tick();expect(f.builder.jobId).toBe(id);expect(f.builder.status).toBe('complete');
});

test('an ambiguous authorization never starts motion or replays itself',async()=>{
  const f=fixture({rpcFailure:'authorizeDelivery'});await f.builder.start();
  expect(f.builder.status).toBe('error');expect(f.stopped).toBe(true);expect(f.trace).not.toContain('native:deliver');
  await f.builder.tick();expect(f.trace.filter(m=>m==='authorizeDelivery')).toHaveLength(1);
});

test('an earlier active intent refuses a new worker and requires reconciliation',async()=>{
  const f=fixture({prior:true});await f.builder.start();expect(f.builder.status).toBe('error');
  expect(f.trace).not.toContain('native:create');await expect(f.builder.stop()).rejects.toThrow('reconciliation');
});

test('an ambiguous receipt stops physics and is never automatically replayed',async()=>{
  const f=fixture({rpcFailure:'confirmDelivery'});await f.builder.start();await f.builder.tick();
  expect(f.builder.status).toBe('error');expect(f.record?.status).toBe('authorized');expect(f.stopped).toBe(true);
  await f.builder.tick();expect(f.trace.filter(m=>m==='confirmDelivery')).toHaveLength(1);
});

test('failed native motion does not produce a durable placement',async()=>{
  const f=fixture({nativeFailure:true});await f.builder.start();await f.builder.tick();
  expect(f.builder.status).toBe('error');expect(f.trace).not.toContain('confirmDelivery');expect(f.stopped).toBe(true);
});

test('stop cancels only active intent; shutdown preserves it for reconciliation',async()=>{
  const f=fixture();await f.builder.start();await f.builder.stop();expect(f.record?.status).toBe('cancelled');
  const g=fixture();await g.builder.start();await g.builder.shutdown();expect(g.record?.status).toBe('authorized');expect(g.stopped).toBe(true);
});

test('uncertain cancellation does not silently clear the episode',async()=>{
  const f=fixture({rpcFailure:'cancelDelivery'});await f.builder.start();await expect(f.builder.stop()).rejects.toThrow('uncertain');
  expect(f.builder.status).toBe('error');expect(f.stopped).toBe(true);
});

test('invalid evidence cannot be promoted into an actor receipt',async()=>{
  for(const badReceipt of [{evidence:'kinematic'},{settled_samples:49},{support_force:0},{robot_contact:true},
    {fingers_open:false},{position:[3,4,5],target:[3,4,5]},{linear_speed:-1},{job_id:'another-job'},
    {owner_slot:1},{time:999},{tick:99999}]){
    const f=fixture({badReceipt});await f.builder.start();await f.builder.tick();
    expect(f.builder.status).toBe('error');expect(f.trace).not.toContain('confirmDelivery');
  }
});

test('only one native request can be outstanding',async()=>{
  const f=fixture();await f.builder.start();await Promise.all([f.builder.tick(),f.builder.tick(),f.builder.tick()]);
  expect(f.trace.filter(m=>m==='native:step')).toHaveLength(4); // Three settling calls, one active call.
});
