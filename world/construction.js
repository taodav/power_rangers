import * as THREE from 'three';
import {BEAM, BOX, PALLET_STOCK, SITE, SLAB_TOP, STATIONS, buildSlots} from './site-plan.js';

/**
 * Draws the job site from the server's state, and overlays arm poses and grippers on the Rangers.
 * The overlay is display-only: it is not actuation, and the physical rig takes no part in it.
 */
const clamp01 = v => Math.max(0, Math.min(1, v));
const ease = t => t * t * (3 - 2 * t);
const METAL = new THREE.MeshStandardMaterial({color: '#39484a', metalness: .6, roughness: .38});
const JOINT = new THREE.MeshStandardMaterial({color: '#7f9085', metalness: .55, roughness: .4});
const CRATE = '#c9a877', STEEL = '#8f3f2f';

function makeGripper(color) {
  const root = new THREE.Group(), add = (parent, geometry, material, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geometry, material); m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m;
  };
  const accent = new THREE.MeshStandardMaterial({color, metalness: .25, roughness: .45});
  add(root, new THREE.CylinderGeometry(.13, .16, .14, 10), JOINT, 0, -.03, 0);
  add(root, new THREE.BoxGeometry(.36, .13, .26), METAL, 0, -.15, 0);
  add(root, new THREE.BoxGeometry(.2, .05, .28), accent, 0, -.09, 0);
  const fingers = [];
  for (const side of [-1, 1]) {
    const hinge = new THREE.Group(); hinge.position.set(side * .15, -.2, 0); root.add(hinge);
    add(hinge, new THREE.BoxGeometry(.075, .24, .17), METAL, 0, -.12, 0);
    const tip = new THREE.Group(); tip.position.set(0, -.24, 0); hinge.add(tip);
    const claw = add(tip, new THREE.BoxGeometry(.065, .2, .14), accent, -side * .025, -.09, 0); claw.rotation.z = side * .2;
    fingers.push({hinge, tip, side});
  }
  return {root, setOpen(amount) {
    for (const f of fingers) {f.hinge.rotation.z = f.side * (.06 + amount * .72); f.tip.rotation.z = -f.side * (.72 - amount * .28);}
  }};
}

function crateMesh() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
  const c = canvas.getContext('2d');
  c.fillStyle = '#ffffff'; c.fillRect(0, 0, 128, 128);
  c.strokeStyle = '#8d7350'; c.lineWidth = 10; c.strokeRect(5, 5, 118, 118);
  c.lineWidth = 7; c.beginPath(); c.moveTo(8, 8); c.lineTo(120, 120); c.stroke();
  c.strokeStyle = '#b7a488'; c.lineWidth = 1.5;
  for (let y = 22; y < 118; y += 16) {c.beginPath(); c.moveTo(10, y); c.lineTo(118, y); c.stroke();}
  const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshStandardMaterial({map, roughness: .8});
}

function buildScenery(scene) {
  const site = new THREE.Group(); site.name = 'job-site'; scene.add(site);
  const box = (w, h, d, color, x, y, z, parent = site) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({color, roughness: .85}));
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
  };
  // Concrete slab with hazard corners, closing the street.
  const slab = box(SITE.slab, .08, SITE.slab, '#8d8c86', SITE.x, SLAB_TOP - .04, SITE.z); slab.castShadow = false;
  for (const a of [-1, 1]) for (const b of [-1, 1]) for (let k = 0; k < 3; k++) {
    const stripe = box(1.2, .012, .22, k % 2 ? '#2b2b2b' : '#e8b93b', SITE.x + a * (SITE.slab / 2 - 1), SLAB_TOP + .006, SITE.z + b * (SITE.slab / 2 - .4 - k * .3));
    stripe.castShadow = false;
  }
  // A marked pad so the footprint reads before the first box lands.
  const pad = box(3.6, .012, 3.6, '#a7a59d', SITE.x, SLAB_TOP + .006, SITE.z); pad.castShadow = false;
  // Pallets for each Ranger, on its own side.
  STATIONS.forEach(({pallet: [x, z]}) => {
    box(2.5, .14, 2.5, '#7b5f42', x, .23, z);
    for (const k of [-1, 0, 1]) box(.26, .1, 2.5, '#5f4a34', x + k * 1, .11, z);
  });
  // Beam rack in front of the slab.
  for (const end of [-1, 1]) box(.3, .5, .9, '#5f4a34', BEAM.rack.x + end * 1.6, .25, BEAM.rack.z);
  // Scaffold and a tower crane beside the stack, for scale. Both are scenery with no collision.
  const crane = new THREE.Group(); crane.position.set(SITE.x + 8.5, 0, SITE.z - 6); site.add(crane);
  const yellow = '#e3ad2c';
  box(2.2, .4, 2.2, '#6f6f6b', 0, .2, 0, crane);
  for (let y = .4; y < 15; y += 1.6) {
    for (const [a, b] of [[-.42, -.42], [.42, -.42], [-.42, .42], [.42, .42]]) box(.1, 1.6, .1, yellow, a, y + .8, b, crane);
    box(.95, .08, .08, yellow, 0, y, -.42, crane); box(.95, .08, .08, yellow, 0, y, .42, crane);
    box(.08, .08, .95, yellow, -.42, y, 0, crane); box(.08, .08, .95, yellow, .42, y, 0, crane);
  }
  const head = new THREE.Group(); head.position.y = 15.2; crane.add(head);
  box(1.2, 1, 1.2, '#d9d4c7', 0, .4, 0, head);
  box(12, .22, .5, yellow, -4.4, 1, 0, head);
  box(3.4, .22, .5, yellow, 2.4, 1, 0, head);
  box(1, .7, .7, '#6f6f6b', 3.6, .55, 0, head);
  box(.05, 7.6, .05, '#2c2c2c', -7.4, -2.8, 0, head);
  box(1, .12, 1, '#c9a877', -7.4, -6.6, 0, head);
  return site;
}

export function createConstruction(scene) {
  const slots = buildSlots();
  buildScenery(scene);
  const crateMaterial = crateMesh();
  const geometry = new THREE.BoxGeometry(BOX * .985, BOX * .985, BOX * .985);
  const placed = new THREE.InstancedMesh(geometry, crateMaterial, slots.length);
  placed.castShadow = true; placed.receiveShadow = true; placed.frustumCulled = false; placed.count = 0;
  placed.setColorAt(0, new THREE.Color('#fff')); scene.add(placed);
  const stock = new THREE.InstancedMesh(geometry, crateMaterial, PALLET_STOCK * STATIONS.length);
  stock.castShadow = true; stock.receiveShadow = true; stock.frustumCulled = false; stock.count = 0; scene.add(stock);
  stock.setColorAt(0, new THREE.Color(CRATE));
  const steel = new THREE.MeshStandardMaterial({color: STEEL, roughness: .55, metalness: .45});
  const beams = [0, 1].map(() => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(BEAM.length, BEAM.height, BEAM.depth), steel);
    m.castShadow = true; m.receiveShadow = true; scene.add(m); return m;
  });
  const carried = [0, 1, 2, 3].map(() => {
    const m = new THREE.Mesh(geometry, crateMaterial.clone()); m.castShadow = true; m.visible = false; scene.add(m); return m;
  });

  const rigs = []; const tints = [];
  const dummy = new THREE.Object3D(), color = new THREE.Color(), white = new THREE.Color('#fff');
  const hold = new THREE.Vector3();

  function attach(models, rangers) {
    if (rigs.length || !models.length) return;
    models.forEach((model, slot) => {
      tints[slot] = new THREE.Color(CRATE).lerp(new THREE.Color(rangers[slot].color), .55);
      carried[slot].material.color.copy(tints[slot]);
      rigs.push(model.elbows.map(elbow => {
        const g = makeGripper(rangers[slot].color); g.root.position.set(0, -.58, .02); g.root.scale.setScalar(.72); elbow.add(g.root); return g;
      }));
    });
  }
  const palletTop = (slot, count) => {
    const [x, z] = STATIONS[slot].pallet, column = (count - 1) % 4, layer = Math.floor((count - 1) / 4);
    return new THREE.Vector3(x + (column % 2 ? .58 : -.58), .3 + BOX / 2 + layer * BOX, z + (column < 2 ? -.58 : .58));
  };

  function setArms(model, shoulder, elbow, amount) {
    if (amount <= 0) return;
    for (let i = 0; i < 2; i++) {
      model.shoulders[i].rotation.x = THREE.MathUtils.lerp(model.shoulders[i].rotation.x, shoulder, amount);
      model.elbows[i].rotation.x = THREE.MathUtils.lerp(model.elbows[i].rotation.x, elbow, amount);
    }
  }

  /** Run after the frame's poses are set. `form` is 1 when the Rangers are folded into the Megazord. */
  function update(state, models, form) {
    const site = state?.site;
    if (!site) return;
    attach(models, state.rangers);
    const physical = !!state.physics, apart = form < .25 && !physical;

    let count = 0;
    site.slots.forEach((s, i) => {
      const plan = slots[i];
      if (plan.kind !== 'box' || s.state !== 'placed') return;
      dummy.position.set(plan.x, plan.y, plan.z); dummy.rotation.set(0, 0, 0); dummy.scale.setScalar(1); dummy.updateMatrix();
      placed.setMatrixAt(count, dummy.matrix); placed.setColorAt(count, tints[placedBy(site, s)] ?? white); count++;
    });
    placed.count = count; placed.instanceMatrix.needsUpdate = true; if (placed.instanceColor) placed.instanceColor.needsUpdate = true;

    let stocked = 0;
    site.stock.forEach((n, slot) => {
      for (let k = 1; k <= n; k++) {
        dummy.position.copy(palletTop(slot, k)); dummy.rotation.set(0, 0, 0); dummy.scale.setScalar(1); dummy.updateMatrix();
        stock.setMatrixAt(stocked, dummy.matrix); stock.setColorAt(stocked, color.set(CRATE)); stocked++;
      }
    });
    stock.count = stocked; stock.instanceMatrix.needsUpdate = true; if (stock.instanceColor) stock.instanceColor.needsUpdate = true;

    models.forEach((model, slot) => {
      const hands = rigs[slot], worker = site.workers[slot], box = carried[slot], plan = slots.find(s => s.id === worker.slot);
      hands.forEach(hand => hand.root.visible = apart);
      box.visible = false;
      let grip = .45;
      if (apart) {
        const inBeam = worker.phase === 'beam';
        if (worker.phase === 'lift') {setArms(model, -1.3, -.35, ease(clamp01(worker.t))); grip = .8 - clamp01(worker.t) * .5;}
        else if (worker.phase === 'toSlot') {setArms(model, -1.3, -.35, 1); grip = .3;}
        else if (worker.phase === 'place' && plan) {setArms(model, -1.3 - plan.level * .42, -.25, 1); grip = .3 + clamp01(worker.t - .6) * 1.4;}
        else if (worker.phase === 'retract') setArms(model, plan?.kind === 'beam' ? -2.9 : -1.3, -.2, 1 - ease(clamp01(worker.t)));
        else if (inBeam) {
          const beam = site.beams.find(b => b.id === worker.slot);
          setArms(model, -2.95, -.1, beam?.stage === 'lifting' ? ease(clamp01(beam.t)) : 1); grip = .3;
        }
        if (['lift', 'toSlot', 'place'].includes(worker.phase) && plan) {
          model.root.updateWorldMatrix(true, false);
          hold.set(0, 1.72, .86); model.root.localToWorld(hold);
          box.visible = true;
          if (worker.phase === 'lift') box.position.lerpVectors(palletTop(slot, site.stock[slot] + 1), hold, ease(clamp01(worker.t)));
          else if (worker.phase === 'place') box.position.lerpVectors(hold, new THREE.Vector3(plan.x, plan.y, plan.z), ease(clamp01(worker.t)));
          else box.position.copy(hold);
          box.rotation.set(0, model.root.rotation.y, 0);
        }
      }
      hands.forEach(hand => hand.setOpen(grip));
    });

    // Beams: resting on the rack, between their carriers, or in place on top.
    const beamSlots = slots.filter(s => s.kind === 'beam');
    beamSlots.forEach((plan, i) => {
      const live = site.beams.find(b => b.id === plan.id), s = site.slots[plan.id - 1], m = beams[i];
      m.visible = true;
      if (s.state === 'placed') return m.position.set(plan.x, plan.y, plan.z);
      const rackY = .5 + BEAM.height / 2 + i * BEAM.height, crew = s.by.map(slot => models[slot]);
      if (live && live.stage !== 'gathering' && crew.length === 2 && apart) {
        const z = (crew[0].root.position.z + crew[1].root.position.z) / 2;
        const y = live.stage === 'lifting' ? THREE.MathUtils.lerp(rackY, BEAM.carryY, ease(clamp01(live.t)))
          : live.stage === 'lowering' ? THREE.MathUtils.lerp(BEAM.carryY, plan.y, ease(clamp01(live.t))) : BEAM.carryY;
        return m.position.set(plan.x, y, z);
      }
      m.position.set(BEAM.rack.x, rackY, BEAM.rack.z);
    });
  }
  const placedBy = (site, s) => s.by[0];
  return {update};
}
