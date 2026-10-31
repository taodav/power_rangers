import {refuseReceipt, type DeliveryRecord, type PlacedReceipt} from './src/delivery-policy';

export const DELIVERY_TARGET=[.93,.83,.99] as const;
/** How much faster than real time a run plays. The physics, timestep and checks are the same at any value. */
export const PLAYBACK=3;
const TICKS_PER_REAL_TIME_CALL=5;
export type NativeWorker={call(command:Record<string,unknown>):Promise<any>;stop():Promise<void>};
type Rpc=(actorId:string,method:string,args:unknown[])=>Promise<any>;
type Status='starting'|'running'|'paused'|'confirming'|'complete'|'error';

/** One physical episode. Actor intent is durable; the MuJoCo world is NOT crash-resumable yet. */
export class PhysicalBuilder {
  readonly jobId=crypto.randomUUID();
  readonly slot=0;
  status:Status='starting';
  physics:any=null;
  actorRecord:DeliveryRecord|null=null;
  error='';
  private worker:NativeWorker|null=null;
  private busy:Promise<void>|null=null;
  private receipts=0;
  constructor(readonly actorId:string,private createWorker:()=>NativeWorker,private rpc:Rpc,
    private event:(text:string)=>void){}

  snapshot(){return {status:this.status,playback:PLAYBACK,jobId:this.jobId,actorId:this.actorId,slot:this.slot,
    physics:this.physics,actorRecord:this.actorRecord,error:this.error};}

  private async fail(){
    this.status='error';
    this.error='Physical delivery stopped with an uncertain or invalid outcome. No motion or receipt was replayed. Stop this episode before starting another.';
    this.event(this.error);
    await this.worker?.stop();this.worker=null;
  }

  async start(){
    if(this.worker||this.physics||this.status!=='starting')throw new Error('A delivery episode cannot be replayed');
    try {
      const previous=await this.rpc(this.actorId,'inspectDelivery',[]);
      if(previous.status==='authorized')throw new Error('An earlier delivery needs reconciliation');
      const sequence=(previous.sequence??0)+1;
      if(!Number.isSafeInteger(sequence)||sequence<1)throw new Error('Invalid delivery history');
      this.worker=this.createWorker();
      for(let i=0;i<3;i++)this.physics=await this.worker.call({command:'step',ticks:50});
      if(this.physics.failed||this.physics.job!=='idle'||this.physics.tick<150)throw new Error('The Ranger did not settle');
      const input={sequence,jobId:this.jobId,objectId:'cargo-0',destinationId:'station-1',ownerSlot:0,nativeReady:true};
      const record=await this.rpc(this.actorId,'authorizeDelivery',[JSON.stringify(input)]);
      if(record.status!=='authorized'||record.jobId!==this.jobId||record.sequence!==sequence||record.ownerSlot!==0||
        record.objectId!=='cargo-0'||record.destinationId!=='station-1')throw new Error('The actor did not authorize this job');
      this.actorRecord=record;
      this.event('Ember saved delivery intent in Terse. Starting a separate native episode; the city preview is suspended.');
      this.physics=await this.worker.call({command:'deliver',jobId:this.jobId,objectId:'cargo-0',destinationId:'station-1'});
      if(this.physics.failed||this.physics.job_id!==this.jobId)throw new Error('Native job binding failed');
      this.status='running';
    } catch {await this.fail();}
  }

  pause(paused:boolean){if(this.status==='running'||this.status==='paused')this.status=paused?'paused':'running';}
  async wait(){await this.busy;}

  tick():Promise<void>{
    if(this.busy)return this.busy;
    if(this.status!=='running'||!this.worker)return Promise.resolve();
    this.busy=this.advance().catch(()=>this.fail()).finally(()=>this.busy=null);
    return this.busy;
  }

  private async advance(){
    const previous=this.physics;
    const state=await this.worker!.call({command:'step',ticks:TICKS_PER_REAL_TIME_CALL*PLAYBACK});
    this.physics=state;
    if(state.failed||state.job_id!==this.jobId||!Number.isFinite(state.time)||state.time<=previous.time)
      throw new Error('Native delivery failed or returned stale state');
    if(state.job!==previous.job)this.event(`MuJoCo: ${state.job.replaceAll('_',' ')}.`);
    if(state.steps>previous.steps)this.event(`MuJoCo confirmed footstep ${state.steps}; ${state.forward.toFixed(2)} m forward travel.`);
    const receipts=state.manipulation_receipts;
    if(!Array.isArray(receipts)||receipts.length<this.receipts)throw new Error('Native receipt history changed');
    for(const receipt of receipts.slice(this.receipts)) {
      if(receipt.event!=='placed')this.event(`Measured ${String(receipt.event).replaceAll('_',' ')} at ${receipt.time.toFixed(2)} s.`);
    }
    this.receipts=receipts.length;
    if(state.job!=='complete')return;
    const receipt=receipts.at(-1) as PlacedReceipt;
    if(!this.actorRecord||refuseReceipt(this.actorRecord,this.jobId,receipt)||
      !receipt.target.every((n,i)=>n===DELIVERY_TARGET[i])||receipt.linear_speed<0||receipt.tilt_deg<0||
      Math.abs(receipt.tick*.01-receipt.time)>1e-8||receipt.tick>state.tick||
      state.placement?.valid!==true||state.objects?.[0]?.id!=='cargo-0'||state.objects[0].placed!==true||state.objects[0].held_by!==null)
      throw new Error('Measured placement evidence is incomplete');
    this.status='confirming';
    this.event('Released box settled on its destination without robot contact. Saving the measured receipt.');
    const record=await this.rpc(this.actorId,'confirmDelivery',[this.jobId,JSON.stringify(receipt)]);
    if(record.status!=='placed'||record.jobId!==this.jobId||JSON.stringify(record.receipt)!==JSON.stringify(receipt))
      throw new Error('Durable placement confirmation did not match');
    this.actorRecord=record;
    await this.worker!.stop();this.worker=null;
    this.status='complete';
    this.event('Ember saved the measured placement receipt in Terse. Native trial ended; final measured pose retained.');
  }

  /** Explicit stop only. An uncertain cancellation keeps the episode latched, never silently retries. */
  async stop():Promise<void>{
    await this.wait();
    await this.worker?.stop();this.worker=null;
    if(this.actorRecord?.status==='authorized'){
      try {
        const record=await this.rpc(this.actorId,'cancelDelivery',[this.jobId]);
        if(record.jobId!==this.jobId||!['cancelled','placed'].includes(record.status))throw new Error('Cancellation did not match');
        this.actorRecord=record;
      } catch {await this.fail();throw new Error('Cancellation is uncertain; this episode remains stopped');}
    } else if(this.status==='error') {
      // Inspect, never repeat an ambiguous authorization. Reconcile only this episode's intent.
      try {
        const record=await this.rpc(this.actorId,'inspectDelivery',[]);
        if(record.status==='authorized'){
          if(record.jobId!==this.jobId)throw new Error('An older job remains active');
          this.actorRecord=record;
          return this.stop();
        }
      } catch {throw new Error('Delivery history needs reconciliation before leaving this episode');}
    }
  }

  /** Process shutdown is not a cancellation or a successful placement. */
  async shutdown(){await this.wait();await this.worker?.stop();this.worker=null;}
}
