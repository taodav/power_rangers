/**
 * What the page says about a physical delivery, derived only from the server's measured state.
 * No three.js here, so these rules can be tested directly.
 */
const RIG_SCALE = 2.4, RIG_FLOOR = .15;

const JOBS = {
  approach: 'Walking to the box', center: 'Lining up with the box', raise: 'Raising its arm', reach: 'Reaching for the box',
  lower: 'Lowering its hand', close: 'Closing its fingers', lift: 'Lifting the box', carry: 'Carrying the box',
  holding: 'Holding the box steady', center_for_place: 'Lining up with the target', place_reach: 'Reaching over the target',
  place_lower: 'Setting the box down', release: 'Opening its fingers', withdraw: 'Backing away', complete: 'Finished moving',
};

/** A physics position in world coordinates: the same axes, scale and floor height the rig is drawn with. */
export function worldPoint([x, y, z]) {
  return {x: y * RIG_SCALE, y: z * RIG_SCALE + RIG_FLOOR, z: x * RIG_SCALE};
}

/** The physical body's place in the world. */
export function builderPose(physics) {
  const [mx, my, , w, x, y, z] = physics.body;
  return {x: my * RIG_SCALE, z: mx * RIG_SCALE, yaw: Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))};
}

/**
 * Delivered only if physics and the actor agree on the same job: a measured placed receipt, the object
 * still passing its checks now, and the actor's saved record holding that receipt. Any one alone is not enough.
 */
export function isDelivered(builder) {
  const physics = builder?.physics, record = builder?.actorRecord;
  if (!physics || !record || builder.status !== 'complete' || builder.error || physics.failed) return false;
  if (record.status !== 'placed' || record.jobId !== builder.jobId || record.receipt?.job_id !== builder.jobId || record.receipt?.evidence !== 'measured') return false;
  const measured = physics.manipulation_receipts?.find(r => r.event === 'placed');
  if (!measured || measured.evidence !== 'measured' || measured.job_id !== builder.jobId) return false;
  return physics.objects?.find(o => o.id === record.objectId)?.placed === true;
}

/** Straight-line distance from the box to its target, in millimetres, from the actor's saved receipt. */
export function placementError(receipt) {
  if (!receipt?.position || !receipt?.target) return null;
  return Math.hypot(...receipt.position.map((v, i) => v - receipt.target[i])) * 1000;
}

/** Page copy and the checklist for one physical run. `name` is the Ranger doing the work. */
export function builderProgress(builder, name) {
  const physics = builder.physics, events = new Set((physics?.manipulation_receipts ?? []).map(r => r.event));
  const delivered = isDelivered(builder), record = builder.actorRecord;
  const steps = [
    {label: 'Gripped', done: events.has('finger_contact')},
    {label: 'Lifted', done: events.has('unsupported_lift')},
    {label: 'Carried', done: events.has('carry')},
    {label: 'Placed', done: events.has('placed')},
    {label: `Saved by ${name}`, done: record?.status === 'placed'},
  ];
  if (builder.status === 'error' || builder.error) {
    return {steps, delivered, failed: true, title: 'Physical run stopped', detail: builder.error || physics?.failed || 'The run stopped with an error.'};
  }
  if (delivered) {
    const error = placementError(record.receipt);
    return {steps, delivered, failed: false, title: 'Delivered',
      detail: `${name} set the box ${error === null ? 'on the target' : `${error.toFixed(1)} mm from the target`}, and saved the measured receipt.`};
  }
  if (builder.status === 'complete') {
    return {steps, delivered, failed: true, title: 'No confirmed placement', detail: 'The run ended, but physics and the saved receipt do not agree on a placement.'};
  }
  if (builder.status === 'starting') return {steps, delivered, failed: false, title: 'Starting physics', detail: `${name} is waking up in MuJoCo.`};
  if (builder.status === 'confirming') return {steps, delivered, failed: false, title: 'Checking the placement', detail: `${name} is saving the measured receipt.`};
  const job = JOBS[physics?.job] ?? 'Working';
  const stepsTaken = physics?.steps ?? 0, speed = builder.playback > 1 ? ` · ${builder.playback}× playback` : '';
  return {steps, delivered, failed: false, title: builder.status === 'paused' ? 'Physics paused' : job,
    detail: `${stepsTaken} measured step${stepsTaken === 1 ? '' : 's'} · ${(physics?.time ?? 0).toFixed(1)} s of simulated time${speed}`};
}
