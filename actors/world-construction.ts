/**
 * The job site. One writer, no I/O: each Ranger's durable claim arrives through `takeRequests`
 * and `receipt`, and nothing moves on a slot until that claim is saved.
 *
 * All motion here is kinematic and runs only while the team is apart and outside the physical rig.
 * Boxes do not touch anything physically. Physical gripping is separate, native work.
 */
import {BEAM, PALLET_STOCK, STATIONS, buildSlots, palletStand} from "../world/site-plan.js";
import {RANGERS} from "./src/world-policy";

const WALK = {box: 2, carry: 1.5, beam: 1.1}, TIMES = {lift: .45, place: .55, retract: .3, beamLift: .9, beamLower: .8};
const ARRIVED = .04, COOLDOWN = {done: .25, refused: .5};

type Bot = {slot:number; x:number; z:number; yaw:number; distance:number; speed:number; target:number[]|null; needsPlan:boolean; status:string};
export type Report = (slot:number, kind:string, text:string) => void;
type Slot = ReturnType<typeof buildSlots>[number] & {state:"open"|"claimed"|"placed"; by:number[]};
type Phase = "idle"|"deciding"|"toPallet"|"lift"|"toSlot"|"place"|"retract"|"toRack"|"waiting"|"beam";
type Worker = {phase:Phase; t:number; slot:number; sequence:number; cooldown:number; placed:number};
type Beam = {stage:"gathering"|"lifting"|"carrying"|"lowering"; t:number};
export type BuildRequest = {slot:number; method:"decideBuild"|"confirmPlaced"; args:unknown[]; sequence:number};

/** Only while the team is four separate bodies. Assembly, combined form and physics stay as they are. */
export const canBuild = (world:{phase:string; physics:unknown}) => world.phase === "roaming" && !world.physics;

export class Construction {
  slots:Slot[] = buildSlots().map(s => ({...s, state:"open" as const, by:[]}));
  workers:Worker[] = [0, 1, 2, 3].map(() => ({phase:"idle", t:0, slot:0, sequence:0, cooldown:0, placed:0}));
  stock:number[] = STATIONS.map(() => PALLET_STOCK);
  beams = new Map<number, Beam>();
  private requests:BuildRequest[] = []; private driving = false; private report:Report = () => {};

  get placed() {return this.slots.filter(s => s.state === "placed").length;}
  get complete() {return this.placed === this.slots.length;}
  takeRequests() {const out = this.requests; this.requests = []; return out;}

  /** Slots that can be started now: supported from below, and beams only once every box is down. */
  open() {
    const boxesDone = this.slots.every(s => s.kind !== "box" || s.state === "placed");
    return this.slots.filter(s => {
      if (s.state === "placed" || s.by.length >= s.crew) return false;
      if (s.kind === "beam") return boxesDone;
      return !s.below || this.slots[s.below - 1].state === "placed";
    });
  }

  rebuild() {
    this.slots = this.slots.map(s => ({...s, state:"open" as const, by:[]}));
    this.stock = STATIONS.map(() => PALLET_STOCK); this.beams.clear();
    this.workers.forEach(w => {w.phase = "idle"; w.t = 0; w.slot = 0; w.cooldown = 0;});
  }

  step(dt:number, active:boolean, bots:Bot[], report:Report = () => {}) {
    if (!Number.isFinite(dt) || dt <= 0 || dt > .1) throw new Error("Bounded fixed timestep required");
    this.report = report;
    if (!active || this.complete) return this.release(active, bots);
    this.driving = true;
    for (const bot of bots) {bot.target = null; bot.needsPlan = false;}
    this.workers.forEach((worker, slot) => this.stepWorker(worker, slot, bots[slot], dt));
    for (const [id, beam] of [...this.beams]) this.stepBeam(id, beam, bots, dt);
  }

  /** Puts unfinished work down and hands the bodies back to the existing planners and assembly. */
  private release(active:boolean, bots:Bot[]) {
    if (!this.driving) return;
    this.driving = false;
    for (const slot of this.slots) if (slot.state !== "placed") {slot.state = "open"; slot.by = [];}
    this.workers.forEach((worker, i) => {
      if (["toSlot", "place"].includes(worker.phase)) this.stock[i] = Math.min(PALLET_STOCK, this.stock[i] + 1);
      worker.phase = "idle"; worker.t = 0; worker.slot = 0; worker.cooldown = 0;
    });
    this.beams.clear();
    if (active) for (const bot of bots) {bot.needsPlan = true; bot.status = "planning";}
  }

  private walk(bot:Bot, x:number, z:number, speed:number, dt:number) {
    const dx = x - bot.x, dz = z - bot.z, remaining = Math.hypot(dx, dz);
    if (remaining < ARRIVED) {bot.x = x; bot.z = z; bot.speed = 0; return true;}
    const travel = Math.min(remaining, speed * dt);
    bot.x += dx / remaining * travel; bot.z += dz / remaining * travel;
    bot.distance += travel; bot.speed = travel / dt;
    this.face(bot, dx, dz, dt, 7);
    return false;
  }
  private face(bot:Bot, dx:number, dz:number, dt:number, rate = 6) {
    const delta = Math.atan2(Math.sin(Math.atan2(dx, dz) - bot.yaw), Math.cos(Math.atan2(dx, dz) - bot.yaw));
    bot.yaw += delta * Math.min(1, dt * rate);
  }

  private stepWorker(worker:Worker, slot:number, bot:Bot, dt:number) {
    worker.cooldown = Math.max(0, worker.cooldown - dt);
    const target = this.slots.find(s => s.id === worker.slot);
    switch (worker.phase) {
      case "idle": {
        bot.speed = 0;
        const open = this.open();
        if (worker.cooldown || !open.length) {if (!open.length) bot.status = "waiting"; return;}
        worker.sequence += 1; worker.phase = "deciding"; bot.status = "choosing";
        this.requests.push({slot, method:"decideBuild", sequence:worker.sequence, args:[JSON.stringify({
          sequence:worker.sequence, x:round(bot.x), z:round(bot.z),
          open:open.map(({id, x, z, level, crew}) => ({id, x:round(x), z:round(z), level, crew}))})]});
        return;
      }
      case "toPallet": {
        const [x, z] = palletStand(slot);
        bot.status = "fetching";
        if (this.walk(bot, x, z, WALK.box, dt)) {
          worker.phase = "lift"; worker.t = 0; this.stock[slot] = Math.max(0, this.stock[slot] - 1);
        }
        return;
      }
      case "lift":
        bot.speed = 0; bot.status = "lifting"; worker.t += dt / TIMES.lift;
        if (worker.t >= 1) {worker.phase = "toSlot"; worker.t = 0;}
        return;
      case "toSlot": {
        const [x, z] = STATIONS[slot].stand;
        bot.status = "carrying";
        if (this.walk(bot, x, z, WALK.carry, dt)) {worker.phase = "place"; worker.t = 0;}
        return;
      }
      case "place":
        bot.speed = 0; bot.status = "placing"; worker.t += dt / TIMES.place;
        if (target) this.face(bot, target.x - bot.x, target.z - bot.z, dt);
        if (worker.t >= 1 && target) {this.settle(target, [slot]); worker.phase = "retract"; worker.t = 0;}
        return;
      case "retract":
        bot.status = "stepping back"; worker.t += dt / TIMES.retract;
        if (worker.t >= 1) {worker.phase = "idle"; worker.t = 0; worker.slot = 0; worker.cooldown = COOLDOWN.done;}
        return;
      case "toRack": {
        if (!target) return;
        const end = target.by[0] === slot ? -1 : 1;
        bot.status = "to the beam";
        if (this.walk(bot, BEAM.rack.x + end * BEAM.endX, BEAM.rack.z, WALK.box, dt)) {
          worker.phase = "waiting"; bot.status = target.by.length < 2 ? "waiting for a partner" : "ready";
        }
        return;
      }
    }
  }

  /** Two Rangers, one beam: nothing lifts until both are in place, and they walk it in step. */
  private stepBeam(id:number, beam:Beam, bots:Bot[], dt:number) {
    const slot = this.slots.find(s => s.id === id)!;
    const crew = slot.by.map(i => ({slot:i, bot:bots[i], worker:this.workers[i]}));
    if (beam.stage === "gathering") {
      if (crew.length === 2 && crew.every(c => c.worker.phase === "waiting")) {
        beam.stage = "lifting"; beam.t = 0;
        for (const c of crew) {c.worker.phase = "beam"; c.bot.status = "lifting together";}
        this.report(-1, "build", `${RANGERS[crew[0].slot].name} and ${RANGERS[crew[1].slot].name} are lifting a beam together.`);
      }
      return;
    }
    if (beam.stage === "lifting") {
      for (const c of crew) {c.bot.speed = 0; this.face(c.bot, slot.x - c.bot.x, slot.z - c.bot.z, dt);}
      beam.t += dt / TIMES.beamLift;
      if (beam.t >= 1) {beam.stage = "carrying"; beam.t = 0;}
    } else if (beam.stage === "carrying") {
      // Both move by the same step, so the beam stays rigid between them.
      const here = crew[0].bot.z, remaining = slot.z - here, travel = Math.sign(remaining) * Math.min(Math.abs(remaining), WALK.beam * dt);
      for (const c of crew) {
        c.bot.z += travel; c.bot.distance += Math.abs(travel); c.bot.speed = Math.abs(travel) / dt;
        c.bot.status = "carrying together"; this.face(c.bot, 0, Math.sign(remaining) || -1, dt);
      }
      if (Math.abs(remaining) <= ARRIVED) {for (const c of crew) c.bot.z = slot.z; beam.stage = "lowering"; beam.t = 0;}
    } else {
      for (const c of crew) {c.bot.speed = 0; c.bot.status = "setting down";}
      beam.t += dt / TIMES.beamLower;
      if (beam.t >= 1) {
        this.settle(slot, slot.by);
        this.beams.delete(id);
        for (const c of crew) {c.worker.phase = "retract"; c.worker.t = 0;}
      }
    }
  }

  /** A slot is done: every Ranger who worked on it gets a receipt to save. */
  private settle(slot:Slot, crew:number[]) {
    slot.state = "placed";
    for (const i of crew) {
      const worker = this.workers[i]; worker.placed += 1;
      this.requests.push({slot:i, method:"confirmPlaced", sequence:worker.sequence, args:[worker.sequence, slot.id, "kinematic"]});
    }
    const names = crew.map(i => RANGERS[i].name).join(" and ");
    this.report(crew.length === 1 ? crew[0] : -1, "build", `${names} placed ${slot.kind === "beam" ? "a beam" : `box ${slot.id}`} (kinematic preview). ${this.placed} of ${this.slots.length} done.`);
    if (this.complete) this.report(-1, "build", "Structure topped out by all four Rangers (kinematic preview).");
  }

  /** Applies an actor's saved claim. The site can have moved on since it asked, so check it again. */
  receipt(request:BuildRequest, memory:{sequence:number; action:string; slotId:number}) {
    if (request.method !== "decideBuild") return;
    const worker = this.workers[request.slot];
    if (worker.phase !== "deciding" || worker.sequence !== request.sequence) return;
    const slot = this.open().find(s => s.id === memory.slotId);
    if (memory.action !== "claim" || !slot) {worker.phase = "idle"; worker.cooldown = COOLDOWN.refused; return;}
    slot.by.push(request.slot); slot.state = "claimed"; worker.slot = slot.id; worker.t = 0;
    if (slot.kind === "beam") {
      worker.phase = "toRack";
      if (!this.beams.has(slot.id)) this.beams.set(slot.id, {stage:"gathering", t:0});
    } else worker.phase = "toPallet";
    this.report(request.slot, "build", `${RANGERS[request.slot].name} saved claim ${memory.sequence} on ${slot.kind === "beam" ? "a beam" : `box ${slot.id}`}.`);
  }

  snapshot() {
    return {placed:this.placed, total:this.slots.length, complete:this.complete, stock:this.stock,
      slots:this.slots.map(s => ({id:s.id, state:s.state, by:s.by})),
      workers:this.workers.map(({phase, t, slot, placed, sequence}) => ({phase, t, slot, placed, claims:sequence})),
      beams:[...this.beams].map(([id, beam]) => ({id, stage:beam.stage, t:beam.t}))};
  }
}

const round = (value:number) => Math.round(value * 100) / 100;
