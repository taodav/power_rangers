import type {NativeWorker} from './world-builder';
import {refuseReceipt,type DeliveryRecord,type PlacedReceipt} from './src/delivery-policy';
import {HERD_STATIONS} from './src/herd-policy';

type Rpc=(id:string,method:string,args:unknown[])=>Promise<any>;
export type HerdOwner={slot:number;actorId:string;jobId:string;record:DeliveryRecord|null};

/** Four durable intents, one shared integrator. No world-state recovery or autonomous navigation yet. */
export class HerdSession {
  readonly owners:HerdOwner[];
  status:'idle'|'starting'|'running'|'paused'|'complete'|'stopped'|'error'='idle';
  physics:any=null;
  error='';
  private worker:NativeWorker|null=null;
  private busy:Promise<void>|null=null;
  constructor(actorIds:string[],private factory:()=>NativeWorker,private rpc:Rpc){
    if(actorIds.length!==4||new Set(actorIds).size!==4||actorIds.some(id=>typeof id!=='string'||!id))
      throw new Error('Four distinct durable hardware owners are required');
    this.owners=actorIds.map((actorId,slot)=>({slot,actorId,jobId:crypto.randomUUID(),record:null}));
  }
  snapshot(){return {status:this.status,owners:this.owners,physics:this.physics,error:this.error};}
  private async fail(){
    this.status='error';
    this.error='Shared physics stopped; an unsafe or uncertain outcome needs reconciliation. Nothing was automatically replayed.';
    await this.worker?.stop();this.worker=null;
  }
  async start(){
    if(this.status!=='idle')throw new Error('A shared episode cannot be replayed');
    this.status='starting';
    try {
      const previous=await Promise.all(this.owners.map(o=>this.rpc(o.actorId,'inspectDelivery',[])));
      if(previous.some(r=>r.status==='authorized'))throw new Error('An earlier intent remains active');
      this.worker=this.factory();
      for(let i=0;i<3;i++)this.physics=await this.worker.call({command:'step',ticks:50});
      if(this.physics.failed||this.physics.tick!==150||this.physics.rangers?.length!==4||this.physics.rangers.some((r:any)=>r.job!=='idle'))
        throw new Error('All four Rangers must settle before authorization');
      const jobs=this.owners.map((o,i)=>({sequence:(previous[i].sequence??0)+1,jobId:o.jobId,
        objectId:`cargo-${o.slot}`,destinationId:`station-${o.slot+1}`,ownerSlot:o.slot,nativeReady:true}));
      // Drain every write even if another actor refuses. Partial intent is visible, never treated as atomic motion.
      const results=await Promise.allSettled(jobs.map((job,i)=>this.rpc(this.owners[i].actorId,'authorizeDelivery',[JSON.stringify(job)])));
      let allAuthorized=true;
      results.forEach((result,i)=>{
        if(result.status!=='fulfilled'){allAuthorized=false;return;}
        const record=result.value,job=jobs[i];
        if(record.status!=='authorized'||record.jobId!==job.jobId||record.ownerSlot!==i||record.sequence!==job.sequence||
          record.objectId!==job.objectId||record.destinationId!==job.destinationId){allAuthorized=false;return;}
        this.owners[i].record=record;
      });
      if(!allAuthorized)throw new Error('The four-actor start barrier did not close');
      this.physics=await this.worker.call({command:'authorize',jobs});
      if(this.physics.failed||this.physics.authorized!==true)throw new Error('Native batch did not start');
      this.status='running';
    } catch {await this.fail();}
  }
  pause(paused:boolean){if(this.status==='running'||this.status==='paused')this.status=paused?'paused':'running';}
  tick(ticks=5):Promise<void>{
    if(!Number.isInteger(ticks)||ticks<1||ticks>50)throw new Error('Use 1–50 control ticks');
    if(this.busy)return this.busy;
    if(this.status!=='running')return Promise.resolve();
    this.busy=this.advance(ticks).catch(()=>this.fail()).finally(()=>this.busy=null);
    return this.busy;
  }
  private async advance(ticks:number){
    const previous=this.physics;
    this.physics=await this.worker!.call({command:'step',ticks});
    if(this.physics.failed||this.physics.tick!==previous.tick+ticks||
      Math.abs(this.physics.physics_time-this.physics.time)>1e-6)throw new Error('Shared physics failed or clocks diverged');
    for(const owner of this.owners){
      const measured=this.physics.rangers[owner.slot];
      if(measured.job_id!==owner.jobId)throw new Error('Native hardware/job binding changed');
      if(measured.job!=='complete'||owner.record?.status==='placed')continue;
      const receipt=measured.manipulation_receipts.at(-1) as PlacedReceipt;
      if(!owner.record||refuseReceipt(owner.record,owner.jobId,receipt,HERD_STATIONS)||
        Math.abs(receipt.tick*.01-receipt.time)>1e-8||receipt.tick>this.physics.tick||
        measured.objects[0]?.id!==`cargo-${owner.slot}`||measured.objects[0].placed!==true||measured.objects[0].held_by!==null||
        measured.placement?.valid!==true)throw new Error('Unproven physical placement');
      const record=await this.rpc(owner.actorId,'confirmDelivery',[owner.jobId,JSON.stringify(receipt)]);
      if(record.status!=='placed'||record.jobId!==owner.jobId||JSON.stringify(record.receipt)!==JSON.stringify(receipt))
        throw new Error('The durable receipt does not match its measured placement');
      owner.record=record;
    }
    if(this.physics.complete&&this.owners.every(o=>o.record?.status==='placed')){
      await this.worker!.stop();this.worker=null;this.status='complete';
    }
  }
  /** Explicit stop reconciles only this episode's active jobs, preserving any completed receipts. */
  async stop(){
    await this.busy;await this.worker?.stop();this.worker=null;
    try {
      for(const owner of this.owners){
        const current=await this.rpc(owner.actorId,'inspectDelivery',[]);
        if(current.status==='authorized'){
          if(current.jobId!==owner.jobId)throw new Error('A different job remains active');
          const record=await this.rpc(owner.actorId,'cancelDelivery',[owner.jobId]);
          if(record.jobId!==owner.jobId||!['placed','cancelled'].includes(record.status))throw new Error('Cancellation did not match');
          owner.record=record;
        } else if(current.jobId===owner.jobId)owner.record=current;
      }
      if(this.status!=='complete')this.status='stopped';
    } catch {await this.fail();throw new Error('Shared intent reconciliation is incomplete');}
  }
  async shutdown(){await this.busy;await this.worker?.stop();this.worker=null;}
}
