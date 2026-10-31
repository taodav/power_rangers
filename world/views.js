import * as THREE from 'three';
import {clearFraction} from './city-plan.js';

/**
 * One chase camera while the Rangers are combined, one per Ranger while they are apart.
 * Free orbit stays available for inspecting anything, including assembly.
 */
const SPLIT_PHASES = new Set(['roaming', 'rendezvous']);
const CHASE = {
  mega: {offset: new THREE.Vector3(2.2, 6.3, -9.2), look: new THREE.Vector3(.2, 3.9, 7), fov: 54, wideFov: 68},
  ranger: {offset: new THREE.Vector3(1.05, 3.4, -6.4), look: new THREE.Vector3(0, 1.85, 5), fov: 56, wideFov: 68},
};
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);
const shortest = angle => Math.atan2(Math.sin(angle), Math.cos(angle));

class ChaseRig {
  constructor(spec) {
    this.spec = spec; this.camera = new THREE.PerspectiveCamera(spec.fov, 1, .2, 1500);
    this.look = new THREE.Vector3(); this.yaw = 0; this.placed = false;
    this.desired = new THREE.Vector3(); this.aim = new THREE.Vector3(); this.pull = 1;
  }
  /** Places the camera behind `pos`, along yaw, and pulls it in rather than through a wall. */
  update(pos, yaw, dt, scale = 1) {
    this.yaw += shortest(yaw - this.yaw) * (this.placed ? damp(2.1, dt) : 1);
    const {offset, look} = this.spec, s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    const place = (out, v, k) => out.set(pos.x + (v.x * c + v.z * s) * k, pos.y + v.y * k, pos.z + (-v.x * s + v.z * c) * k);
    place(this.desired, offset, scale); place(this.aim, look, 1);
    const clear = clearFraction(pos.x, pos.z, this.desired.x, this.desired.z);
    this.pull += (clear - this.pull) * (clear < this.pull ? damp(14, dt) : damp(2, dt));
    this.desired.x = pos.x + (this.desired.x - pos.x) * this.pull;
    this.desired.z = pos.z + (this.desired.z - pos.z) * this.pull;
    if (this.placed) {
      this.camera.position.lerp(this.desired, damp(6.5, dt));
      this.look.lerp(this.aim, damp(9, dt));
    } else {this.camera.position.copy(this.desired); this.look.copy(this.aim); this.placed = true;}
    this.camera.lookAt(this.look);
  }
  frame(rect) {
    this.camera.aspect = rect.w / Math.max(1, rect.h);
    this.camera.fov = rect.w < 300 ? this.spec.wideFov : this.spec.fov;
    this.camera.updateProjectionMatrix();
  }
}

export function createViews({renderer, scene, camera, controls, atmosphere, rangers}) {
  const mega = new ChaseRig(CHASE.mega), quad = [0, 1, 2, 3].map(() => new ChaseRig(CHASE.ranger));
  let mode = 'chase', blend = 0, active = 'four';
  const position = new THREE.Vector3();
  renderer.shadowMap.autoUpdate = false;
  camera.far = 1500; camera.updateProjectionMatrix();
  controls.maxDistance = 220; controls.enabled = false;

  const hud = document.getElementById('view-tags'), tags = rangers.map(ranger => {
    const tag = document.createElement('div'); tag.className = 'view-tag'; tag.style.setProperty('--ranger', ranger.color);
    tag.innerHTML = '<i></i><b></b><span></span>'; tag.querySelector('b').textContent = ranger.name; hud.append(tag); return tag;
  });
  const hint = document.querySelector('.camera-tools > span'), chaseButton = document.getElementById('view-chase');
  function setMode(next) {
    mode = next; controls.enabled = next === 'free'; chaseButton.classList.toggle('on', next === 'chase');
    if (hint) hint.textContent = next === 'free' ? 'DRAG TO ORBIT · SCROLL TO ZOOM' : '';
    if (next === 'free') {tags.forEach(t => t.hidden = true); document.getElementById('mega-tag').hidden = true;}
  }
  chaseButton.addEventListener('click', () => setMode('chase'));
  document.getElementById('frame-team').addEventListener('click', () => setMode('free'));
  document.getElementById('frame-core').addEventListener('click', () => setMode('free'));
  setMode('chase');

  /** Quadrant i at open=1, shrunk into its corner as open falls to 0. */
  function quadRect(i, open, width, height) {
    const w = width / 2 * open, h = height / 2 * open, right = i % 2 === 1, bottom = i >= 2;
    return {x: right ? width - w : 0, y: bottom ? height - h : 0, w, h};
  }

  function draw(cam, rect, height) {
    if (rect.w < 1 || rect.h < 1) return;
    const inset = 1, x = rect.x + inset, w = Math.max(1, rect.w - inset * 2), h = Math.max(1, rect.h - inset * 2), y = height - rect.y - rect.h + inset;
    renderer.setViewport(x, y, w, h); renderer.setScissor(x, y, w, h);
    renderer.render(scene, cam);
  }

  const size = new THREE.Vector2();
  return {
    get mode() {return mode;},
    get layout() {return mode === 'free' ? 'free' : blend > .5 ? 'one' : 'four';},

    /** `core` is the smoothed body pose; `form` is 1 when folded together. */
    update(state, models, core, form, dt) {
      if (!state || !models.length) return;
      active = SPLIT_PHASES.has(state.phase) ? 'four' : 'one';
      const target = active === 'one' ? 1 : 0;
      blend = Math.abs(target - blend) < .002 ? target : blend + (target - blend) * damp(5, dt);

      position.set(core.x, 0, core.z);
      // Back out for the transform so all four limbs can be seen arriving.
      mega.update(position, core.yaw, dt, state.phase === 'combined' ? 1 : 1.35);
      models.forEach((model, i) => {
        const bot = state.bots[i];
        quad[i].update(model.root.position, bot.yaw, dt);
        const tag = tags[i];
        tag.hidden = mode !== 'chase' || blend > .5;
        if (!tag.hidden) {
          const box = quadRect(i, 1 - blend, 1, 1);
          tag.style.left = `calc(${box.x * 100}% + 10px)`; tag.style.top = `calc(${box.y * 100}% + ${i < 2 ? 40 : 10}px)`;
          tag.querySelector('span').textContent = bot.status;
        }
      });
      const megaTag = document.getElementById('mega-tag');
      megaTag.hidden = mode !== 'chase' || blend <= .5;
      const focus = blend > .5 ? position : quad.reduce((sum, _, i) => sum.add(models[i].root.position), new THREE.Vector3()).multiplyScalar(.25);
      atmosphere.follow(focus);
    },

    render() {
      renderer.getSize(size);
      renderer.shadowMap.needsUpdate = true;
      renderer.setScissorTest(true);
      if (mode === 'free') {
        controls.update();
        camera.aspect = size.x / Math.max(1, size.y); camera.updateProjectionMatrix();
        draw(camera, {x: 0, y: 0, w: size.x, h: size.y}, size.y);
      } else {
        // The single view sits underneath; the four views open and close over it like shutters.
        if (blend > .002) {const rect = {x: 0, y: 0, w: size.x, h: size.y}; mega.frame(rect); draw(mega.camera, rect, size.y);}
        const open = 1 - blend;
        if (open > .01) quad.forEach((rig, i) => {const rect = quadRect(i, open, size.x, size.y); rig.frame(rect); draw(rig.camera, rect, size.y);});
      }
      renderer.setScissorTest(false);
    },

    /** The camera under a pointer, with normalized coordinates inside that view, for picking. */
    cameraAt(clientX, clientY, pointer) {
      const box = renderer.domElement.getBoundingClientRect(), x = clientX - box.left, y = clientY - box.top;
      if (mode === 'free' || blend > .5) {
        pointer.set(x / box.width * 2 - 1, -(y / box.height) * 2 + 1);
        return mode === 'free' ? camera : mega.camera;
      }
      const column = x < box.width / 2 ? 0 : 1, row = y < box.height / 2 ? 0 : 1;
      pointer.set((x - column * box.width / 2) / (box.width / 2) * 2 - 1, -((y - row * box.height / 2) / (box.height / 2)) * 2 + 1);
      return quad[row * 2 + column].camera;
    },
  };
}

/** Page controls and labels for the job site. Called with each new state. */
export function updateCityUI(state, busy) {
  const $ = id => document.getElementById(id), site = state.site;
  if (!site) return;
  const roaming = state.phase === 'roaming', rebuild = $('rebuild');
  rebuild.hidden = !(roaming && site.complete); rebuild.disabled = busy || state.paused || !!state.error;
  if (roaming && !state.paused) {
    $('phase-title').textContent = site.complete ? 'Topped out' : 'Building together';
    $('phase-description').textContent = site.complete ? 'All four Rangers finished the structure, so they are back on patrol.' : 'Each Ranger claims its own next job and saves a receipt for every placement.';
    $('scene-state').textContent = 'FOUR BUILDERS · KINEMATIC';
    $('scene-detail').textContent = 'Claims and receipts are durable. Motion and boxes are not physics yet.';
  }
  $('mega-note').textContent = state.physics ? 'MuJoCo rig · building paused' : 'Building paused while combined';
  $('placed-count').textContent = site.placed;
  $('placed-total').textContent = `OF ${site.total} PLACED`;
  const by = $('placed-by');
  if (!by.childElementCount) state.rangers.forEach(ranger => {
    const item = document.createElement('span'); item.style.setProperty('--ranger', ranger.color); item.title = ranger.name;
    item.append(document.createElement('i'), document.createTextNode('0')); by.append(item);
  });
  site.workers.forEach((worker, i) => {by.children[i].lastChild.textContent = worker.placed;});
  // Saved counts include each Ranger's durable build claims, not only its waypoints and joint plans.
  const saved = state.bots.map((bot, i) => bot.decisions + bot.physicsSequence + (site.workers[i].claims ?? 0));
  $('decisions').textContent = saved.reduce((sum, n) => sum + n, 0);
  document.querySelectorAll('.card-decisions').forEach((card, i) => {card.textContent = `${saved[i]} saved`;});
}

/** Eases the body pose between server samples, so nothing steps at the polling rate. */
export function createCoreSmoother() {
  const shown = {x: 0, z: 0, yaw: 0, distance: 0};
  let from = {...shown}, to = null, startedAt = 0, span = .12;
  return (core, now, snap) => {
    if (core !== to) {
      if (!to) Object.assign(shown, core);
      from = {...shown}; span = to ? Math.min(.3, Math.max(.06, now - startedAt)) : .12; startedAt = now; to = core;
    }
    if (snap || Math.hypot(core.x - shown.x, core.z - shown.z) > 12) Object.assign(shown, core);
    else {
      const t = Math.min(1, (now - startedAt) / span);
      shown.x = from.x + (core.x - from.x) * t; shown.z = from.z + (core.z - from.z) * t;
      shown.yaw = from.yaw + shortest(core.yaw - from.yaw) * t; shown.distance = from.distance + (core.distance - from.distance) * t;
    }
    return shown;
  };
}
