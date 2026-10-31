/**
 * The job site as plain data, shared by the server and the browser: a 3×3×3 stack of
 * boxes topped by two long beams that each take two Rangers to carry.
 * Sits on the closed street north of the plaza, clear of the docks and the assembly island.
 */
export const SITE = {x: 0, z: -15.5, slab: 13};
export const BOX = 1.1, BOX_PITCH = 1.15, LEVELS = 3, SLAB_TOP = .03;
export const BEAM = {length: 4.2, height: .5, depth: .7, carryY: 3.75, endX: 2.4, rack: {x: 0, z: -10.5}};

/** Each Ranger's own pallet and working position, so their paths stay mostly apart. */
export const STATIONS = [
  {pallet: [-12, -15.5], stand: [-3.2, -15.5]},
  {pallet: [12, -15.5], stand: [3.2, -15.5]},
  {pallet: [-12, -10], stand: [-2.2, -12.6]},
  {pallet: [12, -10], stand: [2.2, -12.6]},
];
export const PALLET_STOCK = 12;
/** Pallets are reached from the side nearest the site. */
export const palletStand = slot => {
  const [x, z] = STATIONS[slot].pallet;
  return [x - Math.sign(x) * 1.7, z];
};

export function buildSlots() {
  const slots = [];
  for (let level = 0; level < LEVELS; level++) {
    for (let row = -1; row <= 1; row++) {
      for (let column = -1; column <= 1; column++) {
        slots.push({id: slots.length + 1, kind: 'box', level, crew: 1,
          x: SITE.x + column * BOX_PITCH, z: SITE.z + row * BOX_PITCH, y: SLAB_TOP + BOX / 2 + level * BOX,
          below: level ? slots.length + 1 - 9 : 0});
      }
    }
  }
  const top = SLAB_TOP + LEVELS * BOX + BEAM.height / 2;
  for (const offset of [-.6, .6]) {
    slots.push({id: slots.length + 1, kind: 'beam', level: LEVELS, crew: 2, x: SITE.x, z: SITE.z + offset, y: top, below: 0});
  }
  return slots;
}
