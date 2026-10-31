import {describe,test,expect,mock} from 'bun:test';
import {EMPTY_DELIVERY,authorize,failDelivery,recordPlacement,type DeliveryRecord} from './src/delivery-policy';

const job=(over:object={})=>JSON.stringify({jobId:'job-1',slot:0,objectId:'box-1',destination:[1,0,.5],tolerance:.05,...over});
const receipt=(over:object={})=>JSON.stringify({jobId:'job-1',objectId:'box-1',evidence:'measured',released:true,supported:true,settled:true,position:[1.01,0,.5],simulationTime:12.5,...over});
const open=()=>authorize(EMPTY_DELIVERY,0,job());

describe('authorizing a delivery',()=>{
  test('opens one job for this Ranger and changes nothing on an exact retry',()=>{
    const first=open();expect(first.current?.status).toBe('authorized');expect(authorize(first,0,job())).toBe(first);
  });
  test('a Ranger can only authorize work on its own hardware',()=>{
    expect(()=>authorize(EMPTY_DELIVERY,1,job())).toThrow();
    expect(authorize(EMPTY_DELIVERY,1,job({slot:1})).current?.job.slot).toBe(1);
  });
  test('one open job at a time, and a job ID means one job',()=>{
    const first=open();
    expect(()=>authorize(first,0,job({jobId:'job-2'}))).toThrow();
    expect(()=>authorize(first,0,job({objectId:'box-2'}))).toThrow();
  });
  test('malformed jobs are refused',()=>{
    for(const bad of [{jobId:''},{jobId:'a b'},{objectId:''},{slot:4},{slot:1.5},{destination:[1,2]},{destination:[1,2,NaN]},{destination:'x'},{tolerance:0},{tolerance:-1},{tolerance:2},{tolerance:NaN}])
      expect(()=>authorize(EMPTY_DELIVERY,0,job(bad))).toThrow();
    expect(()=>authorize(EMPTY_DELIVERY,0,'null')).toThrow();
  });
});

describe('recording a placement',()=>{
  test('measured evidence that matches the job closes it as delivered',()=>{
    const done=recordPlacement(open(),receipt());
    expect(done.current?.status).toBe('delivered');expect(done.delivered).toBe(1);
  });
  test('an exact retry counts once, and a different receipt is refused',()=>{
    const done=recordPlacement(open(),receipt());
    expect(recordPlacement(done,receipt())).toBe(done);
    expect(()=>recordPlacement(done,receipt({simulationTime:13}))).toThrow();
  });
  test('a timer, a claim or a kinematic preview cannot deliver',()=>{
    for(const evidence of ['kinematic','timer',undefined,''])expect(()=>recordPlacement(open(),receipt({evidence}))).toThrow();
  });
  test('the object must be released, supported and settled',()=>{
    for(const bad of [{released:false},{supported:false},{settled:false},{released:undefined},{settled:'yes'}])expect(()=>recordPlacement(open(),receipt(bad))).toThrow();
  });
  test('it must be the right job, the right object, and at the destination',()=>{
    expect(()=>recordPlacement(EMPTY_DELIVERY,receipt())).toThrow();
    expect(()=>recordPlacement(open(),receipt({jobId:'other'}))).toThrow();
    expect(()=>recordPlacement(open(),receipt({objectId:'box-2'}))).toThrow();
    expect(()=>recordPlacement(open(),receipt({position:[1.06,0,.5]}))).toThrow();
    expect(recordPlacement(open(),receipt({position:[1.04,0,.5]})).delivered).toBe(1);
    for(const bad of [{position:[1,0]},{position:[NaN,0,.5]},{simulationTime:-1},{simulationTime:NaN}])expect(()=>recordPlacement(open(),receipt(bad))).toThrow();
  });
  test('a failed receipt attempt leaves the job open',()=>{
    const first=open();try{recordPlacement(first,receipt({released:false}));}catch{}
    expect(first.current?.status).toBe('authorized');expect(recordPlacement(first,receipt()).delivered).toBe(1);
  });
});

describe('failing and moving on',()=>{
  test('a failure closes the job with a reason, so the Ranger is not stuck',()=>{
    const failed=failDelivery(open(),'job-1','dropped during carry');
    expect(failed.current?.status).toBe('failed');expect(failed.failed).toBe(1);
    expect(failDelivery(failed,'job-1','dropped during carry')).toBe(failed);
    expect(()=>failDelivery(failed,'job-1','something else')).toThrow();
    expect(()=>recordPlacement(failed,receipt())).toThrow();
    expect(authorize(failed,0,job({jobId:'job-2'})).current?.job.jobId).toBe('job-2');
  });
  test('a delivered job cannot be failed afterward, and a reason is required',()=>{
    expect(()=>failDelivery(recordPlacement(open(),receipt()),'job-1','late')).toThrow();
    expect(()=>failDelivery(open(),'job-1','')).toThrow();expect(()=>failDelivery(open(),'other','x')).toThrow();
    expect(()=>failDelivery(open(),'job-1','x'.repeat(201))).toThrow();
  });
  test('a finished job ID can never be reused, including after it leaves the current slot',()=>{
    let r:DeliveryRecord=recordPlacement(open(),receipt());
    r=authorize(r,0,job({jobId:'job-2'}));expect(r.history).toEqual([{jobId:'job-1',status:'delivered'}]);
    r=failDelivery(r,'job-2','stopped');r=authorize(r,0,job({jobId:'job-3'}));
    expect(()=>authorize(r,0,job())).toThrow();expect(r.delivered).toBe(1);expect(r.failed).toBe(1);
  });
  test('history is bounded',()=>{
    let r=EMPTY_DELIVERY;
    for(let i=0;i<40;i++){r=authorize(r,0,job({jobId:`j${i}`}));r=failDelivery(r,`j${i}`,'stop');}
    r=authorize(r,0,job({jobId:'last'}));expect(r.history.length).toBe(32);expect(r.failed).toBe(40);
  });
});

mock.module('terse-sdk/actor',()=>({Actor:class {id='unit-ranger';},Persisted:()=>{},Ephemeral:()=>{}}));
const {WorldRanger}=await import('./src/world-actor');
const actor=async(slot:number)=>{const a=new (WorldRanger as any)();await a.initialize(slot);return a;};
describe('WorldRanger delivery methods (mock SDK)',()=>{
  test('uninitialized actors refuse',async()=>{await expect(new (WorldRanger as any)().authorizeDelivery(job())).rejects.toThrow();});
  test('the actor applies its own slot, and each actor keeps its own record',async()=>{
    const a=await actor(0),b=await actor(1);await a.authorizeDelivery(job());
    await expect(b.authorizeDelivery(job())).rejects.toThrow();
    expect(JSON.parse(await b.inspectDelivery()).current).toBe(null);
  });
  test('a full job round trip, leaving other records alone',async()=>{
    const a=await actor(0),before=JSON.parse(await a.inspect());
    await a.authorizeDelivery(job());const done=JSON.parse(await a.recordPlacement(receipt()));
    expect(done.current.status).toBe('delivered');expect(done.current.receipt.position).toEqual([1.01,0,.5]);
    const after=JSON.parse(await a.inspect());expect([after.decisions,after.sequence]).toEqual([before.decisions,before.sequence]);
  });
  test('failure is available through the actor',async()=>{
    const a=await actor(2);await a.authorizeDelivery(job({slot:2}));
    expect(JSON.parse(await a.failDelivery('job-1','dropped')).current.reason).toBe('dropped');
  });
});
