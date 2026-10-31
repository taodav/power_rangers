import {Actor, Persisted, Ephemeral} from "terse-sdk/actor";
import {waypoint, validateRequest, type PlanRequest} from "./world-policy";
import {authorize, cancel, confirm, type DeliveryRecord} from "./delivery-policy";

type Memory = {slot:number; seed:number; decisions:number; epoch:number; sequence:number; input:string;
  mode:"roam"|"assemble"; target:number[]; docked:boolean};

const readDelivery = (saved:string):DeliveryRecord|null => saved ? JSON.parse(saved) : null;

/** One real, independently persisted actor for each complete robot. */
export class WorldRanger extends Actor {
  @Persisted private record = "";
  @Ephemeral private activation = crypto.randomUUID();
  @Persisted private physicsRecord = "";
  @Persisted private deliveryRecord = "";

  /** Durably authorize one named object and destination for this Ranger's own hardware. */
  async authorizeDelivery(input:string): Promise<string> {
    if(!this.record)throw new Error("Initialize this Ranger first");
    this.deliveryRecord=JSON.stringify(authorize(readDelivery(this.deliveryRecord),JSON.parse(this.record).slot,input));
    return this.deliveryRecord;
  }

  /** Marks the job placed, only with the native adapter's measured receipt for this exact job. */
  async confirmDelivery(jobId:string, receiptJson:string): Promise<string> {
    if(!this.record)throw new Error("Initialize this Ranger first");
    this.deliveryRecord=JSON.stringify(confirm(readDelivery(this.deliveryRecord),jobId,receiptJson));
    return this.deliveryRecord;
  }

  /** Stops an active job on an explicit stop. A completed receipt is left as it is. */
  async cancelDelivery(jobId:string): Promise<string> {
    if(!this.record)throw new Error("Initialize this Ranger first");
    this.deliveryRecord=JSON.stringify(cancel(readDelivery(this.deliveryRecord),jobId));
    return this.deliveryRecord;
  }

  async inspectDelivery(): Promise<string> {return this.deliveryRecord||"{}";}

  async authorizePhysics(input:string): Promise<string> {
    if(!this.record)throw new Error("Initialize this Ranger first");
    const observation=JSON.parse(input);
    if(!Number.isSafeInteger(observation.sequence)||observation.sequence<1||
       !["left","right"].includes(observation.swing)||!Number.isFinite(observation.tilt)||observation.tilt>12||observation.tilt<0||
       observation.leftContact!==true||observation.rightContact!==true)throw new Error("Unsafe or malformed physics observation");
    const previous=this.physicsRecord?JSON.parse(this.physicsRecord):{sequence:0};
    if(observation.sequence===previous.sequence){if(previous.input!==input)throw new Error("Conflicting physics retry");return this.physicsRecord;}
    if(observation.sequence!==previous.sequence+1)throw new Error("Out-of-order physics authorization");
    const {slot}=JSON.parse(this.record);
    const plan=slot<2?{slot,action:"balance",shoulder:(observation.swing==="left"?1:-1)*(slot===0?-.08:.08)}:
      {slot,action:(["left","right"][slot-2]===observation.swing?"step":"support"),stride:.12,clearance:.09};
    this.physicsRecord=JSON.stringify({sequence:observation.sequence,input,plan});
    return this.physicsRecord;
  }

  async initialize(slot:number): Promise<string> {
    if (!Number.isInteger(slot) || slot<0 || slot>3) throw new Error("Invalid Ranger slot");
    if (this.record) {
      if (JSON.parse(this.record).slot !== slot) throw new Error("Hardware ownership is immutable");
      return this.inspect();
    }
    this.record = JSON.stringify({slot, seed:(slot+1)*977, decisions:0, epoch:0, sequence:0,
      input:"", mode:"roam", target:[0,0], docked:false} satisfies Memory);
    return this.inspect();
  }

  async decide(input:string): Promise<string> {
    if (!this.record) throw new Error("Initialize this Ranger first");
    const r = JSON.parse(input) as PlanRequest; validateRequest(r);
    const memory = JSON.parse(this.record) as Memory;
    if (r.sequence === memory.sequence) {
      if (input !== memory.input) throw new Error("Conflicting decision retry");
      return this.inspect();
    }
    if (r.sequence !== memory.sequence+1 || r.epoch < memory.epoch) throw new Error("Stale or out-of-order observation");
    const plan = waypoint(memory.slot, memory.seed, r.mode);
    this.record = JSON.stringify({...memory, ...plan, epoch:r.epoch, sequence:r.sequence, input,
      mode:r.mode, decisions:memory.decisions+1, docked:false});
    return this.inspect();
  }

  async confirmDock(sequence:number, x:number, z:number): Promise<string> {
    if (!this.record) throw new Error("Initialize this Ranger first");
    const memory = JSON.parse(this.record) as Memory;
    if (memory.sequence !== sequence || memory.mode !== "assemble" || ![x,z].every(Number.isFinite) ||
        Math.hypot(x-memory.target[0], z-memory.target[1])>.12) throw new Error("Ranger is not at its docking waypoint");
    this.record = JSON.stringify({...memory, docked:true});
    return this.inspect();
  }

  async inspect(): Promise<string> {
    return JSON.stringify({id:this.id, activation:this.activation, ...(this.record ? JSON.parse(this.record) : {})});
  }

  async inspectPhysics(): Promise<string> {return this.physicsRecord||"{}";}
}
