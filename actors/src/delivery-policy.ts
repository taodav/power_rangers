/**
 * The durable record of one physical delivery: a Ranger authorizes a named object and destination,
 * and later confirms it under the same job ID with the native adapter's measured receipt.
 * Pure functions, so every rule is testable here.
 *
 * A job is intent. Only a measured receipt makes it `placed`: a claim, a timer or an animation cannot.
 * This layer re-checks a receipt against its job and these limits, and never measures anything itself.
 */
export type DeliveryRequest = {sequence:number; jobId:string; objectId:string; destinationId:string; ownerSlot:number; nativeReady:boolean};
export type PlacedReceipt = {event:"placed"; job_id:string; object_id:string; owner_slot:number; destination_id:string;
  tick:number; time:number; evidence:"measured"; settled_samples:number; position:number[]; target:number[];
  support_force:number; linear_speed:number; tilt_deg:number; fingers_open:boolean; robot_contact:boolean; positioned:boolean; valid:boolean};
export type DeliveryRecord = {sequence:number; jobId:string; objectId:string; destinationId:string; ownerSlot:number;
  status:"authorized"|"placed"|"cancelled"; input:string; receipt?:PlacedReceipt; receiptInput?:string; pastJobs:string[]};

/** The limits a placement must meet, matching the checks in physics/ranger.py. Metres, newtons, degrees. */
export const PLACEMENT = {settledSamples:50, minSupport:.5, maxSpeed:.02, maxTilt:8, horizontal:.025, vertical:.015};
/** Known destinations, fixed here so a receipt can't vouch for its own coordinates. Physics frame, metres. */
export const STATIONS:Record<string,number[]> = {"station-1":[.93, .83, .99]};
const PAST_JOBS = 64;
const isName = (v:unknown):v is string => typeof v === "string" && /^[A-Za-z0-9._:-]{1,80}$/.test(v);
const finite = (...values:unknown[]) => values.every(Number.isFinite);
const isPosition = (v:unknown):v is number[] => Array.isArray(v) && v.length === 3 && finite(...v);

/**
 * Saves one authorized job. An exact retry changes nothing. Refused: another Ranger's hardware, a skipped
 * sequence, a reused job ID, or any new job while one is still active.
 */
export function authorize(record:DeliveryRecord|null, slot:number, input:string, stations=STATIONS):DeliveryRecord {
  const r = JSON.parse(input) as DeliveryRequest;
  if (!r || !Number.isSafeInteger(r.sequence) || r.sequence < 1 || !isName(r.jobId) || !isName(r.objectId) || !isName(r.destinationId))
    throw new Error("Invalid delivery request");
  if (!Object.hasOwn(stations, r.destinationId)) throw new Error("Unknown destination");
  if (r.ownerSlot !== slot) throw new Error("A Ranger can only authorize work on its own hardware");
  if (r.nativeReady !== true) throw new Error("The native worker is not ready");
  if (record && r.sequence === record.sequence) {
    if (input !== record.input) throw new Error("Conflicting delivery retry");
    return record;
  }
  if (record?.status === "authorized") throw new Error("Finish or cancel the active job first");
  if (r.sequence !== (record?.sequence ?? 0) + 1) throw new Error("Out-of-order delivery request");
  if (record && (r.jobId === record.jobId || record.pastJobs.includes(r.jobId))) throw new Error("This job ID was already used");
  const pastJobs = record ? [...record.pastJobs, record.jobId].slice(-PAST_JOBS) : [];
  return {sequence:r.sequence, jobId:r.jobId, objectId:r.objectId, destinationId:r.destinationId, ownerSlot:r.ownerSlot, status:"authorized", input, pastJobs};
}

/** Why this receipt can't count as a placement of this job, or null if it can. */
export function refuseReceipt(record:DeliveryRecord, jobId:string, t:PlacedReceipt, stations=STATIONS):string|null {
  if (!t || t.event !== "placed") return "This is not a placed receipt";
  if (t.job_id !== jobId || t.object_id !== record.objectId || t.owner_slot !== record.ownerSlot || t.destination_id !== record.destinationId) return "The receipt is for a different job";
  if (t.evidence !== "measured") return "A delivery needs measured evidence";
  if (!Number.isSafeInteger(t.tick) || t.tick < 0 || !finite(t.time) || t.time < 0) return "The receipt has no valid time";
  if (!Number.isSafeInteger(t.settled_samples) || t.settled_samples < PLACEMENT.settledSamples) return "The object has not settled for long enough";
  if (!finite(t.support_force, t.linear_speed, t.tilt_deg)) return "The receipt has malformed measurements";
  if (t.support_force <= PLACEMENT.minSupport) return "The destination is not supporting the object";
  if (t.linear_speed < 0 || t.tilt_deg < 0) return "The receipt has malformed measurements";
  if (t.linear_speed >= PLACEMENT.maxSpeed) return "The object is still moving";
  if (t.tilt_deg >= PLACEMENT.maxTilt) return "The object is tilted";
  if (t.fingers_open !== true) return "The fingers are not open";
  if (t.robot_contact !== false) return "The robot is still touching the object";
  if (t.positioned !== true || t.valid !== true) return "The native checks did not pass";
  if (!isPosition(t.position) || !isPosition(t.target)) return "The receipt has malformed positions";
  const station = stations[record.destinationId];
  if (!isPosition(station)) return "Unknown destination";
  if (t.target.some((value, axis) => value !== station[axis])) return "The receipt's target is not this station";
  const [x, y, z] = t.position, [a, b, c] = station;
  if (Math.hypot(x - a, y - b) >= PLACEMENT.horizontal || Math.abs(z - c) >= PLACEMENT.vertical) return "The object is not on the target";
  return null;
}

/** Saves the exact receipt once and marks the job placed. An exact retry changes nothing. */
export function confirm(record:DeliveryRecord|null, jobId:string, receiptJson:string, stations=STATIONS):DeliveryRecord {
  if (!record || record.jobId !== jobId) throw new Error("No delivery with this job ID");
  if (record.status === "placed") {
    if (record.receiptInput !== receiptJson) throw new Error("This job already has a different receipt");
    return record;
  }
  if (record.status !== "authorized") throw new Error("This job was cancelled");
  const receipt = JSON.parse(receiptJson) as PlacedReceipt, refusal = refuseReceipt(record, jobId, receipt, stations);
  if (refusal) throw new Error(refusal);
  return {...record, status:"placed", receipt, receiptInput:receiptJson};
}

/** Stops an active job. A completed receipt is never overwritten: the record comes back unchanged. */
export function cancel(record:DeliveryRecord|null, jobId:string):DeliveryRecord {
  if (!record || record.jobId !== jobId) throw new Error("No delivery with this job ID");
  return record.status === "authorized" ? {...record, status:"cancelled"} : record;
}
