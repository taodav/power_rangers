/**
 * The durable record of one physical delivery: a Ranger authorizes a named object and destination,
 * and later records a receipt under the same job ID. Pure functions, so every rule is testable here.
 *
 * A job is intent. Only a measured receipt closes it as delivered: a claim, a timer or an animation
 * cannot. This layer checks a receipt against its job, and never measures anything itself.
 */
export type Vector = [number, number, number];
export type DeliveryJob = {jobId:string; slot:number; objectId:string; destination:Vector; tolerance:number};
/** Reported by the native adapter from physical measurements. Positions are in the physics frame, in metres. */
export type PlacementReceipt = {jobId:string; objectId:string; evidence:"measured"; released:boolean; supported:boolean;
  settled:boolean; position:Vector; simulationTime:number};
type Open = {status:"authorized"; job:DeliveryJob; input:string};
type Closed = {status:"delivered"; job:DeliveryJob; input:string; receipt:PlacementReceipt; receiptInput:string} |
  {status:"failed"; job:DeliveryJob; input:string; reason:string};
export type DeliveryRecord = {current:Open|Closed|null; delivered:number; failed:number; history:{jobId:string; status:string}[]};

export const EMPTY_DELIVERY:DeliveryRecord = {current:null, delivered:0, failed:0, history:[]};
const HISTORY = 32, MAX_TOLERANCE = 1;
const isVector = (v:unknown):v is Vector => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const isName = (v:unknown):v is string => typeof v === "string" && /^[A-Za-z0-9._:-]{1,80}$/.test(v);

export function validateJob(job:DeliveryJob) {
  if (!job || !isName(job.jobId) || !isName(job.objectId) || !Number.isInteger(job.slot) || job.slot < 0 || job.slot > 3 ||
      !isVector(job.destination) || !Number.isFinite(job.tolerance) || job.tolerance <= 0 || job.tolerance > MAX_TOLERANCE)
    throw new Error("Invalid delivery job");
}

/** One open job per Ranger. An exact retry is a no-op, and reusing a job ID for anything else is refused. */
export function authorize(record:DeliveryRecord, slot:number, input:string):DeliveryRecord {
  const job = JSON.parse(input) as DeliveryJob; validateJob(job);
  if (job.slot !== slot) throw new Error("A Ranger can only authorize work on its own hardware");
  const current = record.current;
  if (current?.job.jobId === job.jobId) {
    if (current.input !== input) throw new Error("This job ID was already used for a different job");
    return record;
  }
  if (record.history.some(h => h.jobId === job.jobId)) throw new Error("This job ID was already used for a different job");
  if (current?.status === "authorized") throw new Error("Finish or fail the open job first");
  return {...close(record), current:{status:"authorized", job, input}};
}

/** Moves a finished job into bounded history when the next one starts. */
function close(record:DeliveryRecord):DeliveryRecord {
  const current = record.current;
  if (!current) return record;
  return {...record, current:null, history:[...record.history, {jobId:current.job.jobId, status:current.status}].slice(-HISTORY)};
}

/** Closes the job as delivered, only on measured evidence that matches it. An exact retry is a no-op. */
export function recordPlacement(record:DeliveryRecord, input:string):DeliveryRecord {
  const receipt = JSON.parse(input) as PlacementReceipt, current = record.current;
  if (!current || current.job.jobId !== receipt?.jobId) throw new Error("No job with this ID is open");
  if (current.status === "delivered") {
    if (current.receiptInput !== input) throw new Error("This job already has a different receipt");
    return record;
  }
  if (current.status !== "authorized") throw new Error("This job has already failed");
  if (receipt.evidence !== "measured") throw new Error("A delivery needs measured evidence");
  if (receipt.objectId !== current.job.objectId) throw new Error("The receipt is for a different object");
  if (receipt.released !== true || receipt.supported !== true || receipt.settled !== true) throw new Error("The object is not released, supported and settled");
  if (!isVector(receipt.position) || !Number.isFinite(receipt.simulationTime) || receipt.simulationTime < 0) throw new Error("Malformed placement receipt");
  const [x, y, z] = receipt.position, [a, b, c] = current.job.destination;
  if (Math.hypot(x - a, y - b, z - c) > current.job.tolerance) throw new Error("The object is not at the requested destination");
  return {...record, delivered:record.delivered + 1, current:{...current, status:"delivered", receipt, receiptInput:input}};
}

/** Closes the job as failed, so a Ranger is never stuck on it. A delivered job cannot be failed afterward. */
export function failDelivery(record:DeliveryRecord, jobId:string, reason:string):DeliveryRecord {
  const current = record.current;
  if (!current || current.job.jobId !== jobId) throw new Error("No job with this ID is open");
  if (typeof reason !== "string" || !reason || reason.length > 200) throw new Error("A failure needs a short reason");
  if (current.status === "failed") {
    if (current.reason !== reason) throw new Error("This job already failed for a different reason");
    return record;
  }
  if (current.status === "delivered") throw new Error("This job was already delivered");
  return {...record, failed:record.failed + 1, current:{status:"failed", job:current.job, input:current.input, reason}};
}
