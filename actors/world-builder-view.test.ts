import {describe,test,expect} from 'bun:test';
import {builderPose,builderProgress,isDelivered,placementError,worldPoint} from '../world/builder-view.js';

const JOB='job-1';
const placedReceipt={event:'placed',job_id:JOB,object_id:'cargo-0',owner_slot:0,destination_id:'station-1',tick:7421,time:14.8,evidence:'measured',settled_samples:50,position:[.9287,.8298,.99],target:[.93,.83,.99],support_force:1.1772,linear_speed:0,tilt_deg:0,fingers_open:true,robot_contact:false,positioned:true,valid:true};
/** Shaped like a real completed snapshot from the native adapter. */
const done=(over:any={},physics:any={},record:any={})=>({status:'complete',jobId:JOB,actorId:'a',slot:0,error:'',
  physics:{job:'complete',steps:4,time:39,failed:'',body:[0,0,.9,1,0,0,0],objects:[{id:'cargo-0',placed:true}],
    manipulation_receipts:[{event:'finger_contact'},{event:'unsupported_lift'},{event:'carry'},placedReceipt],...physics},
  actorRecord:{sequence:1,jobId:JOB,objectId:'cargo-0',status:'placed',receipt:placedReceipt,...record},...over});
const label=(p:any)=>p.steps.filter((s:any)=>s.done).map((s:any)=>s.label);

describe('declaring a delivery',()=>{
  test('physics and the actor agreeing on the same job is delivered',()=>{
    expect(isDelivered(done())).toBe(true);
    const p=builderProgress(done(),'Ember');expect(p.title).toBe('Delivered');expect(p.failed).toBe(false);
    expect(p.detail).toContain('1.3 mm');expect(label(p)).toEqual(['Gripped','Lifted','Carried','Placed','Saved by Ember']);
  });
  test('nothing less counts',()=>{
    const r=done().physics.manipulation_receipts;
    for(const bad of [
      done({status:'running'}),done({status:'confirming'}),done({error:'x'}),done({},{failed:'fell'}),done({actorRecord:null}),done({physics:null}),
      done({},{},{status:'authorized'}),done({},{},{status:'cancelled'}),done({},{},{jobId:'other'}),done({},{},{receipt:undefined}),
      done({},{},{receipt:{...placedReceipt,job_id:'other'}}),done({},{},{receipt:{...placedReceipt,evidence:'kinematic'}}),
      done({},{manipulation_receipts:r.slice(0,3)}),done({},{manipulation_receipts:[...r.slice(0,3),{...placedReceipt,job_id:null}]}),
      done({},{manipulation_receipts:[...r.slice(0,3),{...placedReceipt,evidence:'timer'}]}),
      done({},{objects:[{id:'cargo-0',placed:false}]}),done({},{objects:[{id:'other',placed:true}]}),done({},{objects:[]}),
    ])expect(isDelivered(bad)).toBe(false);
    expect(isDelivered(null)).toBe(false);
  });
  test('a run that finished without agreement says so, and never says delivered',()=>{
    const p=builderProgress(done({},{},{status:'authorized'}),'Ember');
    expect(p.title).toBe('No confirmed placement');expect(p.failed).toBe(true);expect(p.delivered).toBe(false);
  });
  test('a placed receipt alone is not shown as saved by the actor',()=>{
    expect(label(builderProgress(done({status:'confirming'},{},{status:'authorized'}),'Ember'))).toEqual(['Gripped','Lifted','Carried','Placed']);
  });
  test('errors are shown, with the reason',()=>{
    const p=builderProgress(done({status:'error',error:'Actor refused'}),'Ember');expect(p.failed).toBe(true);expect(p.detail).toBe('Actor refused');expect(p.title).toBe('Physical run stopped');
    expect(builderProgress({status:'error',error:'',physics:{failed:'fell'}},'Ember').detail).toBe('fell');
  });
});

describe('progress while running',()=>{
  const running=(physics:any,status='running')=>({status,jobId:JOB,slot:0,error:'',actorRecord:{status:'authorized',jobId:JOB},physics:{job:'approach',steps:0,time:0,manipulation_receipts:[],...physics}});
  test('names the current job and counts only measured events',()=>{
    const p=builderProgress(running({job:'carry',steps:3,time:21.5,manipulation_receipts:[{event:'finger_contact'},{event:'unsupported_lift'}]}),'Ember');
    expect(p.title).toBe('Carrying the box');expect(p.detail).toBe('3 measured steps · 21.5 s of simulated time');expect(label(p)).toEqual(['Gripped','Lifted']);
  });
  test('says when it is playing faster than real time, and only then',()=>{
    expect(builderProgress({...running({steps:2,time:5}),playback:3},'Ember').detail).toBe('2 measured steps · 5.0 s of simulated time · 3× playback');
    expect(builderProgress({...running({steps:2,time:5}),playback:1},'Ember').detail).not.toContain('playback');
    expect(builderProgress(running({steps:2,time:5}),'Ember').detail).not.toContain('playback');
  });
  test('singular step, unknown jobs and paused',()=>{
    expect(builderProgress(running({steps:1}),'Ember').detail).toContain('1 measured step ·');
    expect(builderProgress(running({job:'brand_new'}),'Ember').title).toBe('Working');
    expect(builderProgress(running({job:'lift'},'paused'),'Ember').title).toBe('Physics paused');
  });
  test('starting has no physics yet and does not throw',()=>{
    const p=builderProgress({status:'starting',jobId:JOB,slot:0,error:'',physics:null,actorRecord:null},'Ember');
    expect(p.title).toBe('Starting physics');expect(p.steps.every((s:any)=>!s.done)).toBe(true);
  });
});

describe('placing the physical body in the world',()=>{
  test('uses the same axes and scale the rig is drawn with',()=>{
    const pose=builderPose({body:[1,.5,.9,1,0,0,0]});expect(pose.z).toBeCloseTo(2.4);expect(pose.x).toBeCloseTo(1.2);expect(pose.yaw).toBeCloseTo(0);
  });
  test('turning left in physics turns toward +x in the world',()=>{
    const half=Math.SQRT1_2;expect(builderPose({body:[0,0,.9,half,0,0,half]}).yaw).toBeCloseTo(Math.PI/2);
  });
  test('measured positions land where the rig draws them',()=>{
    const p=worldPoint([.93,.83,.99]);expect(p.x).toBeCloseTo(1.992);expect(p.y).toBeCloseTo(2.526);expect(p.z).toBeCloseTo(2.232);
  });
  test('placement error needs both positions',()=>{
    expect(placementError({position:[1,0,0],target:[1,0,.002]})).toBeCloseTo(2);expect(placementError({position:[1,0,0]})).toBe(null);expect(placementError(undefined)).toBe(null);
  });
});
