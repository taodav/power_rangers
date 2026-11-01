/**
 * The city's layout as plain data, shared by the server (blob and route collision)
 * and the browser (meshes), so what is drawn is what things collide with.
 * Deterministic: every run and every client builds the same city.
 */
export const PITCH = 40, STREET_HALF = 7, SIDEWALK = 2.4, GRID = 5;
/** The central four blocks stay clear so all Ranger patrol regions and docks fit in the plaza. */
export const PLAZA_HALF = PITCH - STREET_HALF;
export const LIMIT = GRID * PITCH;

function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FACADES = ['glass', 'office', 'brick'];
const TINTS = {
  glass: ['#8fa9c2', '#7f9db0', '#a0b4c8', '#6f8da8'],
  office: ['#d9d2c4', '#c9c3b8', '#e3dccd', '#bfc4c2'],
  brick: ['#b4785c', '#a4664f', '#c08a68', '#96604f'],
};

function makeBuilding(rand, x, z, w, d) {
  // Downtown rises ahead of the plaza, along the boulevard the Megazord leaves by.
  const downtown = Math.exp(-((x * x + (z - 125) * (z - 125)) / (95 * 95)));
  const roll = rand() + downtown * 0.55;
  const floors = roll > 1.02 ? 24 + rand() * 30 * (0.45 + downtown)
    : roll > 0.62 ? 10 + rand() * 10
    : 4 + rand() * 6;
  const h = Math.round(floors);
  const facade = h > 22 ? (rand() < 0.75 ? 'glass' : 'office') : FACADES[Math.floor(rand() * 3)];
  const tint = TINTS[facade][Math.floor(rand() * 4)];
  const tiers = h > 22
    ? [{w, d, y0: 0, h: Math.round(h * 0.62)},
       {w: w * 0.78, d: d * 0.78, y0: Math.round(h * 0.62), h: Math.round(h * 0.28)},
       {w: w * 0.54, d: d * 0.54, y0: Math.round(h * 0.62) + Math.round(h * 0.28), h: h - Math.round(h * 0.62) - Math.round(h * 0.28)}]
    : [{w, d, y0: 0, h}];
  return {x, z, w, d, h, facade, tint, tiers, roofSeed: Math.floor(rand() * 1e6)};
}

export function buildCity() {
  const rand = random(19930828);
  const blocks = new Map(), buildings = [];
  for (let i = -GRID; i < GRID; i++) {
    for (let j = -GRID; j < GRID; j++) {
      const x0 = i * PITCH + STREET_HALF, x1 = (i + 1) * PITCH - STREET_HALF;
      const z0 = j * PITCH + STREET_HALF, z1 = (j + 1) * PITCH - STREET_HALF;
      const central = (i === -1 || i === 0) && (j === -1 || j === 0);
      const kind = central ? 'plaza' : rand() < 0.11 ? 'park' : 'built';
      const block = {i, j, x0, x1, z0, z1, kind, buildings: []};
      blocks.set(`${i},${j}`, block);
      if (kind !== 'built') continue;
      const inner = SIDEWALK + 0.4, width = x1 - x0 - inner * 2, depth = z1 - z0 - inner * 2;
      const columns = 1 + Math.floor(rand() * 3), rows = 1 + Math.floor(rand() * 3), gap = 1.2;
      for (let c = 0; c < columns; c++) {
        for (let r = 0; r < rows; r++) {
          if (columns * rows > 3 && rand() < 0.08) continue; // an occasional empty lot
          const lotW = (width - gap * (columns - 1)) / columns, lotD = (depth - gap * (rows - 1)) / rows;
          const building = makeBuilding(rand,
            x0 + inner + c * (lotW + gap) + lotW / 2,
            z0 + inner + r * (lotD + gap) + lotD / 2,
            lotW * (0.86 + rand() * 0.14), lotD * (0.86 + rand() * 0.14));
          block.buildings.push(building);
          buildings.push(building);
        }
      }
    }
  }
  return {blocks, buildings};
}

export const CITY = buildCity();

/** True when (x, z) is inside a building footprint, grown by `margin`. Constant-time block lookup. */
export function isBuilding(x, z, margin = 0) {
  const span = Math.ceil(margin / PITCH);
  const bi = Math.floor(x / PITCH), bj = Math.floor(z / PITCH);
  for (let i = bi - span; i <= bi + span; i++) {
    for (let j = bj - span; j <= bj + span; j++) {
      const block = CITY.blocks.get(`${i},${j}`);
      if (!block) continue;
      for (const b of block.buildings)
        if (Math.abs(x - b.x) <= b.w / 2 + margin && Math.abs(z - b.z) <= b.d / 2 + margin) return true;
    }
  }
  return false;
}

/** Ground-level sight line: blocked when any sample falls inside a building footprint. */
export function lineOfSight(ax, az, bx, bz, step = 1.5) {
  const distance = Math.hypot(bx - ax, bz - az), samples = Math.ceil(distance / step);
  for (let k = 1; k < samples; k++) {
    const t = k / samples;
    if (isBuilding(ax + (bx - ax) * t, az + (bz - az) * t)) return false;
  }
  return true;
}

/** The furthest fraction of a→b, in 0..1, that stays outside buildings. For keeping cameras in the street. */
export function clearFraction(ax, az, bx, bz, margin = 0.8, samples = 24) {
  for (let k = 1; k <= samples; k++) {
    const t = k / samples;
    if (isBuilding(ax + (bx - ax) * t, az + (bz - az) * t, margin)) return (k - 1) / samples;
  }
  return 1;
}

export function nearestIntersection(x, z) {
  const clamp = v => Math.max(-GRID + 1, Math.min(GRID - 1, Math.round(v / PITCH))) * PITCH;
  return [clamp(x), clamp(z)];
}

/** Street-connected neighbours of an intersection, staying inside the grid. */
export function neighbours(x, z) {
  const limit = (GRID - 1) * PITCH;
  return [[x + PITCH, z], [x - PITCH, z], [x, z + PITCH], [x, z - PITCH]]
    .filter(([a, b]) => Math.abs(a) <= limit && Math.abs(b) <= limit);
}
