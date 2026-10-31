import {describe,test,expect,mock} from 'bun:test';
import {authorize,cancel,confirm,type DeliveryRecord} from './src/delivery-policy';

const request=(over:object={})=>JSON.stringify({sequence:1,jobId:'job-1',objectId:'cargo-0',destinationId:'station-1',ownerSlot:0,nativeReady:true,...over});
/** Shaped like the placed receipt in physics/ranger.py, with the fields the live adapter adds. */
const receipt=(over:object={})=>JSON.stringify({event:'placed',job_id:'job-1',object_id:'cargo-0',owner_slot:0,destination_id:'station-1',tick:7421,time:14.842,evidence:'measured',settled_samples:50,position:[.6,0,.82],target:[.6,.0013,.82],support_force:1.1772,linear_speed:.0004,tilt_deg:.3,fingers_open:true,robot_contact:false,positioned:true,valid:true,...over});
const active=()=>authorize(null,0,request());
const placed=()=>confirm(active(),'job-1',receipt());

describe('authorizeDelivery',()=>{
  test('saves one authorized job, and an exact retry changes nothing',()=>{
    const first=active();
    expect([first.status,first.sequence,first.jobId,first.ownerSlot]).toEqual(['authorized',1,'job-1',0]);
    expect(authorize(first,0,request())).toBe(first);
  });
  test('a Ranger can only authorize work on its own hardware',()=>{
    expect(()=>authorize(null,1,request())).toThrow();
    expect(authorize(null,1,request({ownerSlot:1})).ownerSlot).toBe(1);
  });
  test('the native worker must be ready',()=>{for(const nativeReady of [false,undefined,'true'])expect(()=>authorize(null,0,request({nativeReady}))).toThrow();});
  test('a conflicting retry or a new job while active is refused',()=>{
    const first=active();
    expect(()=>authorize(first,0,request({objectId:'cargo-1'}))).toThrow();
    expect(()=>authorize(first,0,request({sequence:2,jobId:'job-2'}))).toThrow();
  });
  test('sequences cannot skip, and job IDs cannot be reused',()=>{
    expect(()=>authorize(null,0,request({sequence:2}))).toThrow();
    const done=placed();
    expect(()=>authorize(done,0,request({sequence:3,jobId:'job-2'}))).toThrow();
    expect(()=>authorize(done,0,request({sequence:2}))).toThrow();
    const next=authorize(done,0,request({sequence:2,jobId:'job-2'}));expect(next.status).toBe('authorized');
    const later=authorize(cancel(next,'job-2'),0,request({sequence:3,jobId:'job-3'}));
    expect(()=>authorize(cancel(later,'job-3'),0,request({sequence:4}))).toThrow();
  });
  test('malformed requests are refused',()=>{
    for(const bad of [{sequence:0},{sequence:1.5},{jobId:''},{jobId:'a b'},{objectId:''},{destinationId:7}])expect(()=>authorize(null,0,request(bad))).toThrow();
    expect(()=>authorize(null,0,'null')).toThrow();
  });
});

describe('confirmDelivery',()=>{
  test('a measured receipt marks the job placed and keeps the receipt',()=>{
    const done=placed();expect(done.status).toBe('placed');expect(done.receipt?.support_force).toBe(1.1772);expect(done.sequence).toBe(1);
  });
  test('an exact retry changes nothing, and a different receipt is refused',()=>{
    const done=placed();expect(confirm(done,'job-1',receipt())).toBe(done);
    expect(()=>confirm(done,'job-1',receipt({tick:7422}))).toThrow();
  });
  test('a timer, a claim or a preview cannot place',()=>{
    for(const evidence of ['kinematic','timer',undefined,''])expect(()=>confirm(active(),'job-1',receipt({evidence}))).toThrow();
    expect(()=>confirm(active(),'job-1',receipt({event:'carry'}))).toThrow();
  });
  test('it must match the job exactly',()=>{
    expect(()=>confirm(null,'job-1',receipt())).toThrow();expect(()=>confirm(active(),'other',receipt())).toThrow();
    for(const bad of [{job_id:'other'},{job_id:null},{object_id:'cargo-1'},{owner_slot:1},{destination_id:'station-2'}])expect(()=>confirm(active(),'job-1',receipt(bad))).toThrow();
  });
  test('every measured limit is enforced',()=>{
    for(const bad of [{settled_samples:49},{settled_samples:undefined},{support_force:.5},{support_force:NaN},{linear_speed:.02},{tilt_deg:8},{tilt_deg:-8},
      {fingers_open:false},{fingers_open:'yes'},{robot_contact:true},{robot_contact:undefined},{positioned:false},{valid:false},{valid:undefined},
      {position:[.6,.03,.82]},{position:[.6,0,.84]},{position:[.6,0]},{target:null},{tick:-1},{tick:1.5},{time:-1},{time:null}])
      expect(()=>confirm(active(),'job-1',receipt(bad))).toThrow();
  });
  test('the actor checks position itself, even if the native side says valid',()=>{
    expect(()=>confirm(active(),'job-1',receipt({position:[.7,0,.82],valid:true,positioned:true}))).toThrow();
  });
  test('a refused receipt leaves the job active, so a good one can still land',()=>{
    const first=active();try{confirm(first,'job-1',receipt({valid:false}));}catch{}
    expect(first.status).toBe('authorized');expect(confirm(first,'job-1',receipt()).status).toBe('placed');
  });
});

describe('cancelDelivery',()=>{
  test('cancels an active job, and is safe to repeat',()=>{
    const stopped=cancel(active(),'job-1');expect(stopped.status).toBe('cancelled');
    expect(cancel(stopped,'job-1')).toBe(stopped);
    expect(()=>confirm(stopped,'job-1',receipt())).toThrow();
  });
  test('never overwrites a completed receipt',()=>{
    const done=placed(),after=cancel(done,'job-1');expect(after).toBe(done);expect(after.status).toBe('placed');expect(after.receipt).toBeDefined();
  });
  test('needs the right job',()=>{expect(()=>cancel(null,'job-1')).toThrow();expect(()=>cancel(active(),'other')).toThrow();});
  test('remembered job IDs are bounded',()=>{
    let r:DeliveryRecord|null=null;
    for(let i=1;i<=80;i++){r=authorize(r,0,request({sequence:i,jobId:`j${i}`}));r=cancel(r,`j${i}`);}
    expect(r!.pastJobs.length).toBe(64);expect(r!.sequence).toBe(80);
  });
});

mock.module('terse-sdk/actor',()=>({Actor:class {id='unit-ranger';},Persisted:()=>{},Ephemeral:()=>{}}));
const {WorldRanger}=await import('./src/world-actor');
const actor=async(slot:number)=>{const a=new (WorldRanger as any)();await a.initialize(slot);return a;};
describe('WorldRanger delivery methods (mock SDK)',()=>{
  test('uninitialized actors refuse',async()=>{await expect(new (WorldRanger as any)().authorizeDelivery(request())).rejects.toThrow();});
  test('inspect returns {} before any job, and each actor keeps its own record',async()=>{
    const a=await actor(0),b=await actor(1);expect(await a.inspectDelivery()).toBe('{}');
    await a.authorizeDelivery(request());await expect(b.authorizeDelivery(request())).rejects.toThrow();
    expect(await b.inspectDelivery()).toBe('{}');
  });
  test('a full round trip returns sequence, status and receipt, leaving other records alone',async()=>{
    const a=await actor(0),before=JSON.parse(await a.inspect());
    expect(JSON.parse(await a.authorizeDelivery(request())).status).toBe('authorized');
    const done=JSON.parse(await a.confirmDelivery('job-1',receipt()));
    expect([done.sequence,done.status,done.receipt.tick]).toEqual([1,'placed',7421]);
    expect(await a.inspectDelivery()).toBe(JSON.stringify(done));
    const after=JSON.parse(await a.inspect());expect([after.decisions,after.sequence]).toEqual([before.decisions,before.sequence]);
  });
  test('cancel is available through the actor',async()=>{
    const a=await actor(2);await a.authorizeDelivery(request({ownerSlot:2}));
    expect(JSON.parse(await a.cancelDelivery('job-1')).status).toBe('cancelled');
  });
});
