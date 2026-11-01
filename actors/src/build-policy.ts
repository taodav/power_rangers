/** Each Ranger's own numeric rule for choosing its next job. Not an LLM, and not a central scheduler. */
export const MAX_OPEN = 40;

export type OpenSlot = {id:number; x:number; z:number; level:number; crew:number};
export type BuildObservation = {sequence:number; x:number; z:number; open:OpenSlot[]};
export type BuildDecision = {action:"claim"|"idle"; slotId:number};

export function validateBuild(o: BuildObservation) {
  if (!o || !Number.isSafeInteger(o.sequence) || o.sequence < 1 || ![o.x, o.z].every(Number.isFinite) ||
      Math.abs(o.x) > 400 || Math.abs(o.z) > 400 || !Array.isArray(o.open) || o.open.length > MAX_OPEN ||
      o.open.some(s => !Number.isSafeInteger(s?.id) || s.id < 1 || ![s.x, s.z, s.level, s.crew].every(Number.isFinite)))
    throw new Error("Invalid build observation");
}

/** The lowest level first, because upper boxes need support; then whichever slot is closest to this Ranger. */
export function chooseSlot(o: BuildObservation): BuildDecision {
  let best:OpenSlot|null = null, bestScore = Infinity;
  for (const s of o.open) {
    const score = s.level * 1000 + Math.hypot(s.x - o.x, s.z - o.z);
    if (score < bestScore) {best = s; bestScore = score;}
  }
  return best ? {action:"claim", slotId:best.id} : {action:"idle", slotId:0};
}
