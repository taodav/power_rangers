import {describe,test,expect,mock} from 'bun:test';
import {CITY,GRID,buildCity,PITCH,PLAZA_HALF,STREET_HALF,clearFraction,isBuilding,lineOfSight,neighbours} from '../world/city-plan.js';
import {Construction,canBuild} from './world-construction';
import {chooseSlot,validateBuild} from './src/build-policy';
import {BEAM,SITE,STATIONS,buildSlots,palletStand} from '../world/site-plan.js';
import {RANGERS} from './src/world-policy';

const DT=.05;
describe('city plan',()=>{
  test('a substantial, deterministic city',()=>{
    expect(CITY.buildings.length).toBeGreaterThan(150);
    expect(buildCity().buildings).toEqual(CITY.buildings);
  });
  test('every street is clear, end to end, at both curbs',()=>{
    const limit=GRID*PITCH;
    for(let line=-GRID;line<=GRID;line++)for(let along=-limit;along<=limit;along+=2)for(const offset of [-STREET_HALF+.1,0,STREET_HALF-.1]){
      expect(isBuilding(line*PITCH+offset,along)).toBe(false);expect(isBuilding(along,line*PITCH+offset)).toBe(false);
    }
  });
  test('all Ranger patrol regions and docks fit in the plaza',()=>{
    for(let x=-8.5;x<=8.5;x+=.5)for(let z=-8.5;z<=8.5;z+=.5)expect(isBuilding(x,z,1)).toBe(false);
    for(const r of RANGERS)expect(Math.max(Math.abs(r.dock[0]),Math.abs(r.dock[1]))).toBeLessThan(PLAZA_HALF);
  });
  test('sight lines stop at walls and cameras get pulled in front of them',()=>{
    const b=CITY.buildings[0];
    expect(isBuilding(b.x,b.z)).toBe(true);
    expect(lineOfSight(b.x-b.w,b.z,b.x+b.w,b.z)).toBe(false);
    expect(lineOfSight(0,0,0,PITCH*2)).toBe(true);
    expect(clearFraction(0,0,0,PITCH)).toBe(1);
    expect(clearFraction(b.x-b.w,b.z,b.x,b.z)).toBeLessThan(1);
  });
  test('intersections connect only inside the grid',()=>{
    expect(neighbours(0,0).length).toBe(4);
    for(const [x,z] of neighbours((GRID-1)*PITCH,(GRID-1)*PITCH))expect(Math.max(Math.abs(x),Math.abs(z))).toBeLessThanOrEqual((GRID-1)*PITCH);
  });
});

const bots=()=>[-5.6,5.6,-5.6,5.6].map((x,slot)=>({slot,x,z:slot<2?-5.2:5.2,yaw:0,distance:0,speed:0,target:null as number[]|null,needsPlan:true,status:'planning'}));
/** Answers requests with the real policy, as a Ranger actor would, and keeps the receipts. */
function answer(site:Construction,receipts:any[]=[]) {
  for(const request of site.takeRequests()){
    if(request.method==='confirmPlaced'){receipts.push(request);continue;}
    const input=JSON.parse(request.args[0] as string);
    site.receipt(request,{sequence:input.sequence,...chooseSlot(input)});
  }
}
function run(site:Construction,team=bots(),limit=20000,receipts:any[]=[],each=(_:number)=>{}) {
  let i=0;for(;i<limit&&!site.complete;i++){site.step(DT,true,team);answer(site,receipts);each(i);}
  return i;
}

describe('job site plan',()=>{
  const slots=buildSlots();
  test('27 boxes and 2 two-Ranger beams, each box resting on the one below',()=>{
    expect(slots.filter(s=>s.kind==='box').length).toBe(27);
    const beams=slots.filter(s=>s.kind==='beam');expect(beams.map(b=>b.crew)).toEqual([2,2]);
    for(const s of slots.filter(s=>s.kind==='box'&&s.level)){const below=slots[s.below-1];expect([below.x,below.z,below.level]).toEqual([s.x,s.z,s.level-1]);}
  });
  test('everything a Ranger stands on stays clear of buildings and legal for actor plans',()=>{
    const stops=[...STATIONS.map(s=>s.stand),...[0,1,2,3].map(palletStand),[BEAM.rack.x-BEAM.endX,BEAM.rack.z],[BEAM.rack.x+BEAM.endX,SITE.z-.6]];
    for(const [x,z] of stops){expect(isBuilding(x,z,1)).toBe(false);expect(Math.max(Math.abs(x),Math.abs(z))).toBeLessThanOrEqual(20);}
  });
  test('the site is clear of every dock',()=>{
    for(const r of RANGERS)expect(Math.max(Math.abs(r.dock[0]-SITE.x),Math.abs(r.dock[1]-SITE.z))).toBeGreaterThan(5);
  });
});

describe('each Ranger chooses its own job',()=>{
  const look=(x:number,open:any[])=>({sequence:1,x,z:0,open});
  test('lowest level first, then whichever is closest to this Ranger',()=>{
    const open=[{id:1,x:-1,z:0,level:0,crew:1},{id:2,x:1,z:0,level:0,crew:1},{id:3,x:5,z:0,level:1,crew:1}];
    expect(chooseSlot(look(-5,open))).toEqual({action:'claim',slotId:1});
    expect(chooseSlot(look(5,open))).toEqual({action:'claim',slotId:2});
    expect(chooseSlot(look(0,[]))).toEqual({action:'idle',slotId:0});
  });
  test('malformed observations are refused',()=>{
    const good=look(0,[{id:1,x:0,z:0,level:0,crew:1}]);validateBuild(good);
    for(const bad of [null,{...good,sequence:0},{...good,x:NaN},{...good,z:9999},{...good,open:'x'},{...good,open:[{id:0,x:0,z:0,level:0,crew:1}]},{...good,open:Array(41).fill(good.open[0])}])expect(()=>validateBuild(bad as any)).toThrow();
  });
});

describe('four builders on one site',()=>{
  test('all four finish the whole structure together, and never enter a building',()=>{
    const site=new Construction(),team=bots(),receipts:any[]=[];
    const ticks=run(site,team,20000,receipts,()=>{for(const b of team)expect(isBuilding(b.x,b.z,.5)).toBe(false);});
    expect(site.complete).toBe(true);expect(ticks*DT).toBeLessThan(300);
    expect(site.placed).toBe(29);
    for(const w of site.workers)expect(w.placed).toBeGreaterThan(3);
    expect(receipts.length).toBe(27+4);
    expect(new Set(receipts.map(r=>r.slot)).size).toBe(4);
  });
  test('no box is placed before the box beneath it',()=>{
    const site=new Construction(),order:number[]=[];
    run(site,bots(),20000,[],()=>{for(const s of site.slots)if(s.state==='placed'&&!order.includes(s.id))order.push(s.id);});
    for(const s of site.slots)if(s.below)expect(order.indexOf(s.below)).toBeLessThan(order.indexOf(s.id));
  });
  test('beams wait for every box, take two Rangers, and stay rigid between them',()=>{
    const site=new Construction(),team=bots();
    run(site,team,20000,[],()=>{
      for(const [id,beam] of site.beams){
        expect(site.slots.filter(s=>s.kind==='box').every(s=>s.state==='placed')).toBe(true);
        if(beam.stage==='gathering')continue;
        const crew=site.slots[id-1].by;expect(crew.length).toBe(2);
        expect(team[crew[0]].z).toBe(team[crew[1]].z);
        expect(Math.abs(team[crew[0]].x-team[crew[1]].x)).toBeCloseTo(BEAM.endX*2,5);
      }
    });
    expect(site.complete).toBe(true);
  });
  test('a beam never lifts with one Ranger waiting',()=>{
    const site=new Construction(),team=bots();
    site.slots.filter(s=>s.kind==='box').forEach(s=>s.state='placed');
    site.step(DT,true,team);const requests=site.takeRequests();
    const first=requests[0],input=JSON.parse(first.args[0] as string);
    site.receipt(first,{sequence:input.sequence,...chooseSlot(input)});
    for(let i=0;i<400;i++){site.step(DT,true,team);site.takeRequests();}
    expect(site.workers[first.slot].phase).toBe('waiting');
    expect([...site.beams.values()][0].stage).toBe('gathering');expect(site.placed).toBe(27);
  });
  test('nothing moves until the actor answers, and a stale answer is ignored',()=>{
    const site=new Construction(),team=bots(),before=[team[0].x,team[0].z];
    site.step(DT,true,team);const [request]=site.takeRequests();
    for(let i=0;i<40;i++)site.step(DT,true,team);
    expect([team[0].x,team[0].z]).toEqual(before);
    site.receipt({...request,sequence:request.sequence+1},{sequence:9,action:'claim',slotId:1});
    expect(site.workers[request.slot].phase).toBe('deciding');
  });
  test('two Rangers cannot both take one box',()=>{
    const site=new Construction(),team=bots();site.step(DT,true,team);
    const requests=site.takeRequests();
    for(const r of requests)site.receipt(r,{sequence:r.sequence,action:'claim',slotId:1});
    expect(site.workers.filter(w=>w.slot===1).length).toBe(1);expect(site.slots[0].by.length).toBe(1);
    expect(site.workers.filter(w=>w.phase==='idle').length).toBe(3);
  });
  test('leaving for assembly puts work down, returns the box, and keeps what is built',()=>{
    const site=new Construction(),team=bots();
    let i=0;for(;i<4000&&site.placed<3;i++){site.step(DT,true,team);answer(site);}
    const built=site.placed;
    for(let k=0;k<4000&&!site.workers.some(w=>w.phase==='toSlot');k++){site.step(DT,true,team);answer(site);}
    const held=site.workers.findIndex(w=>w.phase==='toSlot'),stock=site.stock[held];
    site.step(DT,false,team);
    expect(site.placed).toBeGreaterThanOrEqual(built);expect(site.stock[held]).toBe(stock+1);
    expect(site.workers.every(w=>w.phase==='idle')).toBe(true);
    expect(site.slots.filter(s=>s.state!=='placed').every(s=>s.state==='open'&&!s.by.length)).toBe(true);
  });
  test('resumes after assembly, and hands the bodies back to their planners when finished',()=>{
    const site=new Construction(),team=bots();
    for(let i=0;i<600;i++){site.step(DT,true,team);answer(site);}
    site.step(DT,false,team);expect(team.every(b=>b.needsPlan===false)).toBe(true);
    run(site,team);expect(site.complete).toBe(true);
    site.step(DT,true,team);expect(team.every(b=>b.needsPlan)).toBe(true);expect(team[0].status).toBe('planning');
  });
  test('it only builds apart and outside physics, and a new job starts clean',()=>{
    expect(canBuild({phase:'roaming',physics:null})).toBe(true);
    for(const phase of ['rendezvous','assembling','combined','separating'])expect(canBuild({phase,physics:null})).toBe(false);
    expect(canBuild({phase:'roaming',physics:{}})).toBe(false);
    const site=new Construction();run(site);const counts=site.workers.map(w=>w.placed);site.rebuild();
    expect(site.placed).toBe(0);expect(site.workers.map(w=>w.placed)).toEqual(counts);expect(site.stock).toEqual([12,12,12,12]);
  });
  test('the timestep is bounded',()=>{for(const dt of [0,-1,.2,NaN,Infinity])expect(()=>new Construction().step(dt,true,bots())).toThrow();});
});

mock.module('terse-sdk/actor',()=>({Actor:class {id='unit-ranger';},Persisted:()=>{},Ephemeral:()=>{}}));
const {WorldRanger}=await import('./src/world-actor');
const actor=async(slot:number)=>{const a=new (WorldRanger as any)();await a.initialize(slot);return a;};
const claim=(sequence:number,open=[{id:7,x:1,z:0,level:0,crew:1}])=>JSON.stringify({sequence,x:0,z:0,open});
describe('durable build records (mock SDK)',()=>{
  test('uninitialized actors refuse',async()=>{await expect(new (WorldRanger as any)().decideBuild(claim(1))).rejects.toThrow();});
  test('each actor keeps its own record, and exact retries are idempotent',async()=>{
    const a=await actor(0),b=await actor(1);const first=await a.decideBuild(claim(1));
    expect(await a.decideBuild(claim(1))).toBe(first);expect(JSON.parse(first).slotId).toBe(7);
    await expect(a.decideBuild(claim(1,[]))).rejects.toThrow();await expect(a.decideBuild(claim(3))).rejects.toThrow();
    expect(JSON.parse(await b.inspect()).build).toBe(null);
  });
  test('receipts must match the saved claim, count once, and accumulate',async()=>{
    const a=await actor(0);await expect(a.confirmPlaced(1,7,'kinematic')).rejects.toThrow();
    await a.decideBuild(claim(1));await expect(a.confirmPlaced(2,7,'kinematic')).rejects.toThrow();await expect(a.confirmPlaced(1,8,'kinematic')).rejects.toThrow();
    await a.confirmPlaced(1,7,'kinematic');await a.confirmPlaced(1,7,'kinematic');expect(JSON.parse(await a.inspect()).build.placed).toEqual([{slotId:7,evidence:'kinematic'}]);
    await a.decideBuild(claim(2,[{id:9,x:1,z:0,level:0,crew:1}]));await a.confirmPlaced(2,9,'measured');expect(JSON.parse(await a.inspect()).build.placed[1]).toEqual({slotId:9,evidence:'measured'});
    await a.decideBuild(claim(3,[]));await expect(a.confirmPlaced(3,0,'kinematic')).rejects.toThrow();
  });
  test('a receipt must say what backs it',async()=>{
    const a=await actor(0);await a.decideBuild(claim(1));
    for(const bad of [undefined,'','timer','MEASURED'])await expect(a.confirmPlaced(1,7,bad as any)).rejects.toThrow();
    expect(JSON.parse(await a.inspect()).build.placed).toEqual([]);
  });
  test('the site labels everything it settles as kinematic',()=>{
    const site=new Construction(),receipts:any[]=[];run(site,bots(),20000,receipts);
    expect(receipts.length).toBeGreaterThan(0);for(const r of receipts)expect(r.args[2]).toBe('kinematic');
  });
  test('build records leave decide and physics records alone',async()=>{
    const a=await actor(0);const before=JSON.parse(await a.inspect());await a.decideBuild(claim(1));const after=JSON.parse(await a.inspect());
    expect(after.decisions).toBe(before.decisions);expect(after.sequence).toBe(before.sequence);expect(after.build.sequence).toBe(1);
  });
});
