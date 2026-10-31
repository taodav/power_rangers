import {authorize,confirm,type DeliveryRecord,type DeliveryRequest} from './delivery-policy';

/** Versioned fixed workspaces, in metres, matching physics/herd.py. Never supplied by a browser. */
export const HERD_ORIGINS=[[-2,-2],[1,-2],[-2,1],[1,1]] as const;
export const HERD_STATIONS:Record<string,number[]>=Object.fromEntries(HERD_ORIGINS.map(([x,y],slot)=>
  [`station-${slot+1}`,[x+.93,y+.83,.99]]));

export function authorizeHerd(record:DeliveryRecord|null,slot:number,input:string){
  if(!Number.isInteger(slot)||slot<0||slot>3)throw new Error('Invalid Ranger slot');
  const request=JSON.parse(input) as DeliveryRequest;
  if(request?.objectId!==`cargo-${slot}`||request?.destinationId!==`station-${slot+1}`)
    throw new Error('This Ranger cannot claim another workspace');
  return authorize(record,slot,input,HERD_STATIONS);
}

export function confirmHerd(record:DeliveryRecord|null,jobId:string,receiptJson:string){
  return confirm(record,jobId,receiptJson,HERD_STATIONS);
}
