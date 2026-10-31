import * as THREE from 'three';
import {CITY, GRID, PITCH, SIDEWALK, STREET_HALF} from './city-plan.js';

/**
 * Draws the plan in city-plan.js. Everything is merged by material, so the whole city
 * is a handful of draw calls and four simultaneous views stay affordable.
 */
class Builder {
  positions = []; normals = []; colors = []; uvs = []; indices = [];
  /** One axis-aligned box. `sides` restricts it to walls; uv is in texture repeats per unit. */
  box(x, y0, z, w, h, d, color, {sidesOnly = false, cellU = 0, cellV = 0, offset = 0} = {}) {
    const c = new THREE.Color(color), x0 = x - w / 2, x1 = x + w / 2, z0 = z - d / 2, z1 = z + d / 2, y1 = y0 + h;
    const quad = (a, b, cc, dd, n, width) => {
      const base = this.positions.length / 3;
      this.positions.push(...a, ...b, ...cc, ...dd);
      for (let i = 0; i < 4; i++) {this.normals.push(...n); this.colors.push(c.r, c.g, c.b);}
      const u = width * cellU, v = h * cellV;
      this.uvs.push(offset, 0, offset + u, 0, offset + u, v, offset, v);
      this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], w);
    quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], w);
    quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], d);
    quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], d);
    if (!sidesOnly) quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], w);
  }
  /** Any indexed geometry, placed by matrix and flat-coloured. */
  geometry(source, matrix, color) {
    const c = new THREE.Color(color), g = source.clone().applyMatrix4(matrix), base = this.positions.length / 3;
    const p = g.attributes.position, n = g.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      this.positions.push(p.getX(i), p.getY(i), p.getZ(i));
      this.normals.push(n.getX(i), n.getY(i), n.getZ(i));
      this.colors.push(c.r, c.g, c.b); this.uvs.push(0, 0);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) this.indices.push(base + g.index.getX(i));
    else for (let i = 0; i < p.count; i++) this.indices.push(base + i);
  }
  mesh(material, {cast = true, receive = true} = {}) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setIndex(this.indices);
    const m = new THREE.Mesh(g, material);
    m.castShadow = cast; m.receiveShadow = receive; m.frustumCulled = false;
    return m;
  }
}

const COLUMNS = 8, ROWS = 16;
/** A greyscale wall with a window grid, plus a matching emissive map of the lit windows. */
function facadeTextures(style, renderer) {
  const make = () => {const c = document.createElement('canvas'); c.width = 256; c.height = 512; return c;};
  const wall = make(), glow = make(), w = wall.getContext('2d'), g = glow.getContext('2d');
  const look = {
    glass: {wall: '#d3dae0', pane: '#8d9fb0', gx: .06, gy: .12},
    office: {wall: '#f4f1ea', pane: '#88939c', gx: .2, gy: .3},
    brick: {wall: '#f2e9df', pane: '#79808a', gx: .3, gy: .32},
  }[style];
  w.fillStyle = look.wall; w.fillRect(0, 0, 256, 512);
  g.fillStyle = '#000'; g.fillRect(0, 0, 256, 512);
  const cw = 256 / COLUMNS, ch = 512 / ROWS;
  let seed = style.length * 97;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLUMNS; c++) {
    const x = c * cw + cw * look.gx / 2, y = r * ch + ch * look.gy / 2, pw = cw * (1 - look.gx), ph = ch * (1 - look.gy);
    w.fillStyle = look.pane; w.globalAlpha = .9 + rand() * .1; w.fillRect(x, y, pw, ph); w.globalAlpha = 1;
    if (rand() < .14) {g.fillStyle = rand() < .7 ? '#ffd9a0' : '#fff1cf'; g.globalAlpha = .3 + rand() * .5; g.fillRect(x, y, pw, ph); g.globalAlpha = 1;}
  }
  const texture = (canvas, color) => {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    if (color) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return new THREE.MeshStandardMaterial({vertexColors: true, map: texture(wall, true), emissiveMap: texture(glow, true),
    emissive: '#ffffff', emissiveIntensity: .42, roughness: style === 'glass' ? .35 : .85, metalness: style === 'glass' ? .35 : 0});
}

const CELL_U = 1 / (1.25 * COLUMNS), CELL_V = 1 / (1 * ROWS);

function addRoof(building, tier, props, glow, rand) {
  const top = tier.y0 + tier.h;
  props.box(building.x, top, building.z, tier.w + .3, .28, tier.d + .3, '#8b8d8c');
  props.box(building.x, top + .28, building.z, tier.w - .6, .05, tier.d - .6, '#5c5f60');
  const units = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < units; i++) {
    const ax = (rand() - .5) * (tier.w - 2.2), az = (rand() - .5) * (tier.d - 2.2);
    props.box(building.x + ax, top + .33, building.z + az, 1 + rand() * .8, .55 + rand() * .4, 1 + rand() * .8, '#a3a7a6');
  }
  if (building.h < 18 && rand() < .22) {
    // A water tower on old low-rises.
    const tx = building.x + (rand() - .5) * (tier.w - 3), tz = building.z + (rand() - .5) * (tier.d - 3);
    const barrel = new THREE.CylinderGeometry(.85, .85, 1.5, 10), cap = new THREE.ConeGeometry(.98, .55, 10), leg = new THREE.CylinderGeometry(.06, .06, 1.2, 5);
    props.geometry(barrel, new THREE.Matrix4().makeTranslation(tx, top + 2.1, tz), '#8c6a4f');
    props.geometry(cap, new THREE.Matrix4().makeTranslation(tx, top + 3.1, tz), '#6d5140');
    for (const [a, b] of [[-.6, -.6], [.6, -.6], [-.6, .6], [.6, .6]]) props.geometry(leg, new THREE.Matrix4().makeTranslation(tx + a, top + .9, tz + b), '#5c5f60');
  }
  if (building.h > 30) {
    // Towers carry a mast and a red aircraft beacon.
    const height = 3 + rand() * 4;
    props.box(building.x, top + .3, building.z, .28, height, .28, '#7c8081');
    glow.box(building.x, top + .3 + height, building.z, .42, .42, .42, '#ff5a45');
  }
}

function addStreetFurniture(props, glow, rand) {
  const limit = GRID * PITCH;
  const pole = new THREE.CylinderGeometry(.07, .1, 3.6, 6);
  for (let line = -GRID; line <= GRID; line++) {
    for (let along = -limit + PITCH / 2; along < limit; along += PITCH / 2.5) {
      if (Math.abs(along % PITCH) < STREET_HALF + 2 || Math.abs(Math.abs(along % PITCH) - PITCH) < STREET_HALF + 2) continue;
      for (const curb of [-1, 1]) {
        const offset = curb * (STREET_HALF + .9);
        for (const vertical of [true, false]) {
          const x = vertical ? line * PITCH + offset : along, z = vertical ? along : line * PITCH + offset;
          const sway = vertical ? [-curb * .85, 0] : [0, -curb * .85];
          props.geometry(pole, new THREE.Matrix4().makeTranslation(x, 1.8, z), '#4e5456');
          props.box(x + sway[0] / 2, 3.55, z + sway[1] / 2, vertical ? 1 : .14, .1, vertical ? .14 : 1, '#4e5456');
          glow.box(x + sway[0], 3.42, z + sway[1], .36, .12, .36, '#ffe2ad');
        }
      }
    }
  }
  // Parked cars along the curbs, small against the Rangers.
  const paints = ['#b6423a', '#3d6ea8', '#e3dfd2', '#2e3336', '#d0a03e', '#5b8a6d'];
  for (let i = -GRID; i < GRID; i++) for (let j = -GRID; j <= GRID; j++) {
    if ((i === -1 || i === 0) && Math.abs(j) <= 1) continue;
    for (let k = 0; k < 3; k++) {
      if (rand() < .45) continue;
      const along = (i + .22 + k * .28 + rand() * .04) * PITCH, side = rand() < .5 ? -1 : 1, across = j * PITCH + side * (STREET_HALF - 1), paint = paints[Math.floor(rand() * paints.length)];
      for (const vertical of [true, false]) {
        if (rand() < .5) continue;
        const x = vertical ? across : along, z = vertical ? along : across;
        props.box(x, .1, z, vertical ? .85 : 1.9, .32, vertical ? 1.9 : .85, paint);
        props.box(x, .42, z, vertical ? .74 : 1, .26, vertical ? 1 : .74, '#3b464d');
      }
    }
  }
}

function addStreetMarkings(ground) {
  const limit = GRID * PITCH, paint = '#d8d4c4', paintY = .012;
  for (let line = -GRID; line <= GRID; line++) {
    for (let along = -limit; along < limit; along += PITCH) {
      for (let dash = along + STREET_HALF + 4; dash < along + PITCH - STREET_HALF - 4; dash += 4) {
        ground.box(line * PITCH, 0, dash, .22, paintY, 2, paint);
        ground.box(dash, 0, line * PITCH, 2, paintY, .22, paint);
      }
    }
  }
  // Crosswalks on every approach to every intersection.
  for (let i = -GRID + 1; i < GRID; i++) for (let j = -GRID + 1; j < GRID; j++) {
    const cx = i * PITCH, cz = j * PITCH;
    for (let stripe = -STREET_HALF + 1; stripe <= STREET_HALF - 1; stripe += 1.4) for (const dir of [-1, 1]) {
      ground.box(cx + stripe, 0, cz + dir * (STREET_HALF + 1.4), .7, paintY, 2, paint);
      ground.box(cx + dir * (STREET_HALF + 1.4), 0, cz + stripe, 2, paintY, .7, paint);
    }
  }
}

function addBlocks(ground, props, rand) {
  const trunk = new THREE.CylinderGeometry(.14, .2, 1.2, 6), leaves = new THREE.IcosahedronGeometry(1, 1);
  const tree = (x, z, scale = 1) => {
    props.geometry(trunk, new THREE.Matrix4().makeTranslation(x, .6 * scale, z).multiply(new THREE.Matrix4().makeScale(scale, scale, scale)), '#5d4a3a');
    const shade = ['#6a8f4e', '#7da156', '#587f4c'][Math.floor(rand() * 3)];
    props.geometry(leaves, new THREE.Matrix4().makeTranslation(x, 1.8 * scale, z).multiply(new THREE.Matrix4().makeScale(1.05 * scale, 1.25 * scale, 1.05 * scale)), shade);
  };
  for (const block of CITY.blocks.values()) {
    const cx = (block.x0 + block.x1) / 2, cz = (block.z0 + block.z1) / 2, w = block.x1 - block.x0, d = block.z1 - block.z0;
    ground.box(cx, -.03, cz, w, .17, d, '#a6a39a');
    if (block.kind === 'built') {
      ground.box(cx, .14, cz, w - SIDEWALK * 2, .02, d - SIDEWALK * 2, '#6d6c68');
      for (let x = block.x0 + 3; x < block.x1 - 2; x += 5) for (const z of [block.z0 + 1.2, block.z1 - 1.2]) if (rand() < .6) tree(x, z, .8);
    } else if (block.kind === 'park') {
      ground.box(cx, .14, cz, w - SIDEWALK * 2, .03, d - SIDEWALK * 2, '#7d9a5a');
      ground.box(cx, .17, cz, 2.2, .01, d - SIDEWALK * 2, '#cbc3ad');
      ground.box(cx, .17, cz, w - SIDEWALK * 2, .01, 2.2, '#cbc3ad');
      for (let k = 0; k < 22; k++) {
        const x = cx + (rand() - .5) * (w - 7), z = cz + (rand() - .5) * (d - 7);
        if (Math.abs(x - cx) > 2.4 && Math.abs(z - cz) > 2.4) tree(x, z, .9 + rand() * .6);
      }
    } else {
      // Civic plaza pavers. Trees stay at the outer edges, clear of the Ranger patrol regions.
      ground.box(cx, .14, cz, w - SIDEWALK * 2, .015, d - SIDEWALK * 2, '#b9b6a8');
      for (let t = 2; t < 26; t += 4) {
        const outerX = block.x0 < 0 ? block.x0 + 2 : block.x1 - 2, outerZ = block.z0 < 0 ? block.z0 + 2 : block.z1 - 2;
        tree(outerX, block.z0 + t, 1.1); tree(block.x0 + t, outerZ, 1.1);
      }
    }
  }
}

/** Silhouettes beyond the playable grid, so the horizon reads as more city rather than an edge. */
function addSkyline(walls, rand) {
  const tints = ['#a0a9b4', '#b3b4b6', '#8f9aa8', '#aca6a0'], limit = GRID * PITCH + 18;
  for (let i = 0; i < 420; i++) {
    const angle = rand() * Math.PI * 2, radius = limit * Math.SQRT2 * .8 + rand() * 330;
    const x = Math.sin(angle) * radius, z = Math.cos(angle) * radius;
    if (Math.abs(x) < limit && Math.abs(z) < limit) continue;
    const w = 9 + rand() * 13, d = 9 + rand() * 13, h = 8 + rand() * rand() * 62;
    walls.box(x, 0, z, w, h, d, tints[Math.floor(rand() * 4)], {cellU: CELL_U, cellV: CELL_V, offset: rand()});
  }
}

const SKY_VERTEX = `varying vec3 vDir;void main(){vDir=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
const SKY_FRAGMENT = `varying vec3 vDir;uniform vec3 sunDir;
void main(){vec3 d=normalize(vDir);float h=clamp(d.y,0.,1.);
vec3 horizon=vec3(.97,.75,.56),middle=vec3(.70,.74,.82),zenith=vec3(.34,.48,.70);
vec3 c=mix(horizon,middle,smoothstep(0.,.22,h));c=mix(c,zenith,smoothstep(.18,.75,h));
float s=max(dot(d,sunDir),0.);c+=vec3(1.,.72,.42)*pow(s,8.)*.34+vec3(1.,.9,.72)*pow(s,240.)*.9;
gl_FragColor=vec4(c,1.);}`;
export const SUN_DIRECTION = new THREE.Vector3(-.5, .46, .73).normalize();

/** Late-afternoon light: warm, low sun with long shadows, and a haze that hides the far edge. */
export function applyAtmosphere(scene, renderer, sun) {
  const haze = new THREE.Color('#e7c6a6');
  scene.background = haze; scene.fog = new THREE.Fog(haze, 90, 460);
  renderer.toneMappingExposure = 1.02;
  scene.traverse(o => {if (o.isHemisphereLight) {o.color.set('#ffe7cc'); o.groundColor.set('#8d8fa0'); o.intensity = 1.7;}});
  sun.color.set('#ffdcae'); sun.intensity = 3.6;
  const shadow = sun.shadow.camera;
  Object.assign(shadow, {left: -55, right: 55, top: 55, bottom: -55, near: 1, far: 420}); shadow.updateProjectionMatrix();
  sun.shadow.bias = -.0004; sun.shadow.normalBias = .06;
  scene.add(sun.target);
  const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 24, 16), new THREE.ShaderMaterial({
    vertexShader: SKY_VERTEX, fragmentShader: SKY_FRAGMENT, side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {sunDir: {value: SUN_DIRECTION}}}));
  sky.renderOrder = -10; scene.add(sky);
  return {
    /** Keep the shadow frustum over `focus`, snapped to texels so shadows do not crawl as the camera moves. */
    follow(focus) {
      const texel = 110 / sun.shadow.mapSize.x, snap = v => Math.round(v / texel) * texel;
      sky.position.set(focus.x, 0, focus.z);
      sun.target.position.set(snap(focus.x), 0, snap(focus.z));
      sun.position.copy(sun.target.position).addScaledVector(SUN_DIRECTION, 210);
    },
  };
}

export function makeCity(scene, renderer) {
  const city = new THREE.Group(); city.name = 'city';
  let seed = 4242;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  const asphalt = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400), new THREE.MeshStandardMaterial({color: '#555a5e', roughness: .96}));
  asphalt.rotation.x = -Math.PI / 2; asphalt.position.y = -.05; asphalt.receiveShadow = true; city.add(asphalt);

  const walls = {glass: new Builder(), office: new Builder(), brick: new Builder()};
  const props = new Builder(), glow = new Builder(), ground = new Builder();
  for (const b of CITY.buildings) {
    b.tiers.forEach((tier, index) => {
      walls[b.facade].box(b.x, tier.y0, b.z, tier.w, tier.h, tier.d, b.tint, {sidesOnly: true, cellU: CELL_U, cellV: CELL_V, offset: (b.roofSeed + index) % 97 / 97});
      addRoof(b, tier, props, glow, rand);
    });
  }
  addBlocks(ground, props, rand);
  addStreetMarkings(ground);
  addStreetFurniture(props, glow, rand);
  addSkyline(walls.office, rand);

  for (const [style, builder] of Object.entries(walls)) city.add(builder.mesh(facadeTextures(style, renderer)));
  city.add(props.mesh(new THREE.MeshStandardMaterial({vertexColors: true, roughness: .78, metalness: .05})));
  city.add(ground.mesh(new THREE.MeshStandardMaterial({vertexColors: true, roughness: .95}), {cast: false}));
  city.add(glow.mesh(new THREE.MeshBasicMaterial({vertexColors: true}), {cast: false, receive: false}));
  scene.add(city);
  return city;
}
