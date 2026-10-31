/** Numeric waypoint policy, deliberately not an LLM or a locomotion policy. */
export const RANGERS = [
  {name: "Ember", color: "#ed6655", role: "Left arm", quadrant: [-1, -1], dock: [-3.7, -1.5]},
  {name: "Cobalt", color: "#679df2", role: "Right arm", quadrant: [1, -1], dock: [3.7, -1.5]},
  {name: "Sol", color: "#e8bb56", role: "Left leg", quadrant: [-1, 1], dock: [-1.55, 3.7]},
  {name: "Jade", color: "#6cb99a", role: "Right leg", quadrant: [1, 1], dock: [1.55, 3.7]},
] as const;

export type PlanRequest = {epoch:number; sequence:number; mode:"roam"|"assemble"; x:number; z:number};
export function validateRequest(r: PlanRequest) {
  if (!r || !Number.isSafeInteger(r.epoch) || r.epoch < 0 || !Number.isSafeInteger(r.sequence) || r.sequence < 1 ||
      !["roam", "assemble"].includes(r.mode) || ![r.x, r.z].every(Number.isFinite) || Math.abs(r.x)>20 || Math.abs(r.z)>20)
    throw new Error("Invalid world observation");
}
export function waypoint(slot:number, seed:number, mode:"roam"|"assemble") {
  if (!Number.isInteger(slot) || slot<0 || slot>3) throw new Error("Unknown Ranger");
  const random = () => {seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296;};
  const ranger = RANGERS[slot];
  const target = mode === "assemble" ? [...ranger.dock] : [ranger.quadrant[0]*(4.0+random()*3.5), ranger.quadrant[1]*(3.6+random()*3.6)];
  return {seed, target};
}
