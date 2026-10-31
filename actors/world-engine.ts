import {RANGERS} from "./src/world-policy";

export type Bot = {slot:number; id:string; x:number; z:number; yaw:number; distance:number; speed:number;
  target:number[]|null; status:string; sequence:number; decisions:number; docked:boolean; needsPlan:boolean; activation:string; physicsSequence:number};
export type WorldEvent = {id:number; time:number; slot:number; kind:string; text:string};
export class World {
  time=0; epoch=0; phase="roaming"; progress=0; paused=false; error=""; patrol=false;
  events:WorldEvent[]=[]; eventId=0; core={x:0,z:0,yaw:0,distance:0};
  physics:any=null;physicsAvailable=false;
  bots:Bot[]; run=crypto.randomUUID();
  constructor() {
    this.bots=RANGERS.map((r,slot)=>({slot,id:`world-${this.run}-${slot}`,x:r.quadrant[0]*5.6,z:r.quadrant[1]*5.2,
      yaw:0,distance:0,speed:0,target:null,status:"connecting",sequence:0,decisions:0,docked:false,needsPlan:true,activation:"",physicsSequence:0}));
    this.event(-1,"system","Four complete Rangers. One shared assembly core.");
  }
  event(slot:number,kind:string,text:string) {this.events=[...this.events.slice(-119),{id:++this.eventId,time:this.time,slot,kind,text}];}
  command(command:string) {
    if(command==="pause") {this.paused=!this.paused;this.event(-1,"system",this.paused?"World paused; simulation clock frozen.":"World resumed.");return;}
    if(this.error) throw new Error("The runtime reported an error; restart the world before continuing");
    if(command==="assemble") {
      if(this.phase!=="roaming")throw new Error("Assemble is available while the team is roaming");
      this.epoch++;this.phase="rendezvous";this.progress=0;this.paused=false;
      this.bots.forEach(b=>{b.target=null;b.needsPlan=true;b.docked=false;b.status="recalling";b.speed=0;});
      this.event(-1,"assembly","Assembly requested. Each Ranger chooses its own docking waypoint.");
    } else if(command==="separate") {
      if(this.phase!=="combined")throw new Error("Separate after assembly is complete");
      this.phase="separating";this.progress=1;this.patrol=false;this.paused=false;
      this.event(-1,"assembly","Releasing four independent modules. No identities are replaced.");
    } else if(command==="patrol") {
      if(this.phase!=="combined")throw new Error("Combine the team before moving as one");
      this.patrol=!this.patrol;this.event(-1,"motion",this.patrol?"Joint-driven MuJoCo patrol requested.":"Finish the current physical step, then hold.");
    } else throw new Error("Unknown world command");
  }
  step(dt:number) {
    if(!Number.isFinite(dt)||dt<=0||dt>.1)throw new Error("Bounded fixed timestep required");
    if(this.paused||this.error)return;
    this.time+=dt;
    if(this.phase==="roaming"||this.phase==="rendezvous") {
      for(const b of this.bots) {
        b.speed=0;
        if(!b.target||b.docked||b.status==="confirming")continue;
        const dx=b.target[0]-b.x,dz=b.target[1]-b.z,remaining=Math.hypot(dx,dz);
        if(remaining<.035) {
          b.x=b.target[0];b.z=b.target[1];b.target=null;
          if(this.phase==="roaming"){b.needsPlan=true;b.status="planning";}else b.status="confirming";
          continue;
        }
        const travel=Math.min(remaining,dt*(1.15+b.slot*.11));
        b.x+=dx/remaining*travel;b.z+=dz/remaining*travel;b.distance+=travel;b.speed=travel/dt;
        const desired=Math.atan2(dx,dz),delta=Math.atan2(Math.sin(desired-b.yaw),Math.cos(desired-b.yaw));
        b.yaw+=delta*Math.min(1,dt*7);b.status=this.phase==="roaming"?"roaming":"approaching";
      }
      if(this.phase==="rendezvous"&&this.bots.every(b=>b.docked)) {
        this.phase="assembling";this.progress=0;this.bots.forEach(b=>b.status="transforming");
        this.event(-1,"assembly","4 / 4 durable docking receipts. Magnetic assembly rails engaged.");
      }
    } else if(this.phase==="assembling") {
      this.progress=Math.min(1,this.progress+dt/4.5);
      if(this.progress>=1){this.phase="combined";this.bots.forEach(b=>b.status="linked");this.event(-1,"assembly","Megazord linked. Four Ranger identities, one articulated silhouette.");}
    } else if(this.phase==="separating") {
      this.progress=Math.max(0,this.progress-dt/3.5);
      if(this.progress<=0){this.phase="roaming";this.epoch++;this.core={x:0,z:0,yaw:0,distance:0};this.bots.forEach(b=>{const d=RANGERS[b.slot].dock;b.x=d[0];b.z=d[1];b.target=null;b.docked=false;b.needsPlan=true;b.status="planning";});this.event(-1,"assembly","Team released. Independent waypoint planning resumed.");}
    }
  }
  snapshot() {return {run:this.run,time:this.time,epoch:this.epoch,phase:this.phase,progress:this.progress,
    paused:this.paused,error:this.error,patrol:this.patrol,core:{...this.core},bots:this.bots.map(b=>({...b})),events:this.events,
    control:"Four Terse actors · numeric planners",physics:this.physics,physicsAvailable:this.physicsAvailable,
    boundary:"Roaming and assembly are kinematic; combined walking uses the native MuJoCo rig. No LLM calls."};}
}
