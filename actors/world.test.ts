import {describe,test,expect,mock} from 'bun:test';
import {World} from './world-engine';
import {RANGERS,validateRequest,waypoint} from './src/world-policy';

describe('four numeric waypoint policies',()=>{
  test('exactly four distinct hardware roles and docks',()=>{
    expect(RANGERS.length).toBe(4);expect(new Set(RANGERS.map(r=>r.role)).size).toBe(4);
    expect(new Set(RANGERS.map(r=>String(r.dock))).size).toBe(4);
  });
  test('each actor keeps its own bounded patrol quadrant',()=>{
    RANGERS.forEach((r,slot)=>{let seed=977*(slot+1);for(let i=0;i<200;i++){
      const plan=waypoint(slot,seed,'roam');seed=plan.seed;
      expect(plan.target[0]*r.quadrant[0]).toBeGreaterThanOrEqual(4);
      expect(plan.target[0]*r.quadrant[0]).toBeLessThan(7.5);
      expect(plan.target[1]*r.quadrant[1]).toBeGreaterThanOrEqual(3.6);
      expect(plan.target[1]*r.quadrant[1]).toBeLessThan(7.2);
      expect(Math.hypot(...plan.target)).toBeLessThan(11.75);
    }});
  });
  test('assembly selects the actor-owned dock, without advancing random state',()=>{
    RANGERS.forEach((r,slot)=>expect(waypoint(slot,123,'assemble')).toEqual({seed:123,target:[...r.dock]}));
  });
  test('deterministic replay has the same target',()=>expect(waypoint(0,777,'roam')).toEqual(waypoint(0,777,'roam')));
  test('reject malformed observations and slots',()=>{
    const good={epoch:0,sequence:1,mode:'roam' as const,x:0,z:0};validateRequest(good);
    for(const bad of [null,{}, {...good,sequence:0},{...good,sequence:1.5},{...good,epoch:-1},{...good,x:NaN},{...good,z:21},{...good,mode:'fly'}])expect(()=>validateRequest(bad as any)).toThrow();
    for(const slot of [-1,4,1.5,NaN])expect(()=>waypoint(slot,0,'roam')).toThrow();
  });
});
describe('one bounded kinematic world',()=>{
  test('four distinct actor IDs, no fifth controller',()=>{
    const world=new World();expect(world.bots.length).toBe(4);expect(new Set(world.bots.map(b=>b.id)).size).toBe(4);
    expect(world.run).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  });
  test('only approved state transitions are accepted',()=>{
    const world=new World();expect(()=>world.command('separate')).toThrow();expect(()=>world.command('patrol')).toThrow();expect(()=>world.command('reset')).toThrow();
    world.command('assemble');expect(world.phase).toBe('rendezvous');expect(world.epoch).toBe(1);expect(()=>world.command('assemble')).toThrow();
  });
  test('all four receipts are required, proximity alone is not a receipt',()=>{
    const world=new World();world.command('assemble');
    world.bots.forEach((b,i)=>{b.x=RANGERS[i].dock[0];b.z=RANGERS[i].dock[1];b.docked=i<3;});
    world.step(.05);expect(world.phase).toBe('rendezvous');world.bots[3].docked=true;world.step(.05);expect(world.phase).toBe('assembling');
  });
  test('assembly and separation preserve identities and saved decisions',()=>{
    const world=new World(),ids=world.bots.map(b=>b.id);world.bots.forEach(b=>b.decisions=12);
    world.command('assemble');world.bots.forEach(b=>b.docked=true);world.step(.05);
    for(let i=0;i<91;i++)world.step(.05);expect(world.phase).toBe('combined');expect(world.progress).toBe(1);
    world.command('patrol');world.step(.05);expect(world.core.x).toBe(0); // Only the physics worker may move the combined root.
    world.command('separate');for(let i=0;i<71;i++)world.step(.05);
    expect(world.phase).toBe('roaming');expect(world.core.x).toBe(0);expect(world.progress).toBe(0);
    expect(world.bots.map(b=>b.id)).toEqual(ids);expect(world.bots.map(b=>b.decisions)).toEqual([12,12,12,12]);
    world.bots.forEach((b,i)=>{expect([b.x,b.z]).toEqual([...RANGERS[i].dock]);expect(b.needsPlan).toBe(true);expect(b.docked).toBe(false);});
  });
  test('pause freezes clock and motion, error fails closed',()=>{
    const world=new World();world.bots[0].target=[6,6];world.step(.05);world.command('pause');const saved=world.snapshot();
    for(let i=0;i<20;i++)world.step(.05);expect(world.snapshot()).toEqual(saved);
    world.command('pause');world.error='test failure';const time=world.time;world.step(.05);expect(world.time).toBe(time);expect(()=>world.command('assemble')).toThrow();
  });
  test('movement is bounded and arrives without overshoot',()=>{
    const world=new World(),bot=world.bots[0];bot.x=0;bot.z=0;bot.target=[.06,0];bot.needsPlan=false;
    world.step(.05);expect(bot.x).toBeLessThanOrEqual(.06);world.step(.05);expect(bot.x).toBe(.06);expect(bot.needsPlan).toBe(true);
    for(const dt of [0,-1,.2,Infinity,NaN])expect(()=>world.step(dt)).toThrow();
  });
  test('events are bounded and ordered',()=>{
    const world=new World();for(let i=0;i<150;i++)world.event(0,'test',`Event ${i}`);
    expect(world.events.length).toBe(120);expect(world.events[119].id).toBe(151);expect(world.events[0].id).toBe(32);
  });
});

// Unit-only adapter: exercises actor decisions, not the SDK's persistence implementation.
mock.module('terse-sdk/actor',()=>({Actor:class {id='unit-ranger';},Persisted:()=>{},Ephemeral:()=>{}}));
const {WorldRanger}=await import('./src/world-actor');
const actor=()=>new (WorldRanger as any)();
const read=async(a:any)=>JSON.parse(await a.inspect());
const request=(sequence:number,mode='roam',epoch=0)=>JSON.stringify({sequence,mode,epoch,x:0,z:0});
describe('actor-owned decision guards (mock SDK)',()=>{
  test('initialization is idempotent and ownership immutable',async()=>{
    const a=actor();await a.initialize(0);await a.initialize(0);expect((await read(a)).decisions).toBe(0);
    await expect(a.initialize(1)).rejects.toThrow();await expect(actor().initialize(4)).rejects.toThrow();
  });
  test('uninitialized decisions refuse',async()=>{await expect(actor().decide(request(1))).rejects.toThrow();});
  test('four records evolve independently',async()=>{
    const actors=[actor(),actor(),actor(),actor()];for(let i=0;i<4;i++)await actors[i].initialize(i);
    await actors[0].decide(request(1));expect(await Promise.all(actors.map(async a=>(await read(a)).decisions))).toEqual([1,0,0,0]);
  });
  test('exact retry is idempotent; conflicting, skipped, and stale requests refuse',async()=>{
    const a=actor();await a.initialize(0);const first=await a.decide(request(1));expect(await a.decide(request(1))).toBe(first);
    await expect(a.decide(request(1,'assemble'))).rejects.toThrow();await expect(a.decide(request(3))).rejects.toThrow();
    await a.decide(request(2,'assemble',1));await expect(a.decide(request(3,'roam',0))).rejects.toThrow();expect((await read(a)).decisions).toBe(2);
  });
  test('only a matching assembly goal near its dock can be confirmed',async()=>{
    const a=actor();await a.initialize(0);await a.decide(request(1));await expect(a.confirmDock(1,0,0)).rejects.toThrow();
    await a.decide(request(2,'assemble',1));const [x,z]=RANGERS[0].dock;
    await expect(a.confirmDock(1,x,z)).rejects.toThrow();await expect(a.confirmDock(2,x+1,z)).rejects.toThrow();await expect(a.confirmDock(2,NaN,z)).rejects.toThrow();
    await a.confirmDock(2,x,z);expect((await read(a)).docked).toBe(true);
    await a.decide(request(3,'roam',2));expect((await read(a)).docked).toBe(false);
  });
  test('physics plans preserve four distinct limb owners and require safe observations',async()=>{
    const actors=[actor(),actor(),actor(),actor()];for(let i=0;i<4;i++)await actors[i].initialize(i);
    const input=JSON.stringify({sequence:1,swing:'left',tilt:3,leftContact:true,rightContact:true});
    const plans=await Promise.all(actors.map(async a=>JSON.parse(await a.authorizePhysics(input))));
    expect(plans.map(p=>p.plan.slot)).toEqual([0,1,2,3]);expect(plans.map(p=>p.plan.action)).toEqual(['balance','balance','step','support']);
    expect(JSON.parse(await actors[0].authorizePhysics(input))).toEqual(plans[0]);
    await expect(actors[0].authorizePhysics(JSON.stringify({sequence:2,swing:'left',tilt:20,leftContact:true,rightContact:true}))).rejects.toThrow();
    await expect(actors[0].authorizePhysics(JSON.stringify({sequence:2,swing:'left',tilt:3,leftContact:false,rightContact:true}))).rejects.toThrow();
    await expect(actors[0].authorizePhysics(JSON.stringify({sequence:3,swing:'left',tilt:3,leftContact:true,rightContact:true}))).rejects.toThrow();
  });
});
