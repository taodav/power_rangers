import {Actor,Persisted,Ephemeral} from 'terse-sdk/actor';
import {authorizeHerd,confirmHerd} from './herd-policy';
import {cancel,type DeliveryRecord} from './delivery-policy';

const read=(saved:string):DeliveryRecord|null=>saved?JSON.parse(saved):null;

/** Four independent durable hardware owners; not a fifth central decision actor. */
export class HerdRanger extends Actor {
  @Persisted private slot=-1;
  @Persisted private delivery='';
  @Ephemeral private activation=crypto.randomUUID();

  async initialize(slot:number):Promise<string>{
    if(!Number.isInteger(slot)||slot<0||slot>3)throw new Error('Invalid hardware slot');
    if(this.slot!==-1&&this.slot!==slot)throw new Error('Hardware ownership is immutable');
    this.slot=slot;return this.inspect();
  }
  async authorizeDelivery(input:string):Promise<string>{
    this.delivery=JSON.stringify(authorizeHerd(read(this.delivery),this.slot,input));
    return this.delivery;
  }
  async confirmDelivery(jobId:string,receiptJson:string):Promise<string>{
    if(this.slot<0)throw new Error('Initialize this hardware owner first');
    this.delivery=JSON.stringify(confirmHerd(read(this.delivery),jobId,receiptJson));
    return this.delivery;
  }
  async cancelDelivery(jobId:string):Promise<string>{
    this.delivery=JSON.stringify(cancel(read(this.delivery),jobId));return this.delivery;
  }
  async inspect():Promise<string>{return JSON.stringify({id:this.id,slot:this.slot,activation:this.activation,delivery:read(this.delivery)});}
  async inspectDelivery():Promise<string>{return this.delivery||'{}';}
}
