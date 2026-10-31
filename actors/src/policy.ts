/** Pure policy/arbiter used by both real Terse actors and headless evaluations. */
import pairedProfiles from "../../src/power_rangers/gaits.json"
export const LEGS = ["FR", "FL", "RR", "RL"] as const
export type Leg = typeof LEGS[number]
export const ORDER: Leg[] = ["RL", "FL", "RR", "FR"]
export const PAIRS: Leg[][] = [["FR", "RL"], ["FL", "RR"]]
export type Goal = { vx: number; vy: number; yaw_rate: number }
export type Profile = "baseline" | "brisk" | "fast"
export type Policy = "fixed" | "reactive" | "ordered" | "trot"
export const PROFILES = {
    baseline: { shift_ticks: 60, settle_ticks: 15, duration: .7, clearance: .035 },
    brisk: { shift_ticks: 30, settle_ticks: 8, duration: .45, clearance: .025 }
}
export type Foot = {
    position: number[]; contact: boolean; nominal: number[]; last_step: number;
    age_ticks: number; shift_distance: number; remaining_ticks: number; deadline_tick: number | null
}
export type Observation = {
    episode: string; revision: number; tick: number; step: number;
    policy?: Policy; profile?: Profile; goal?: Goal; next_pair?: number;
    center?: number[]; formation_yaw?: number;
    reference_center?: number[]; reference_yaw?: number;
    body?: { position: number[]; velocity: number[]; yaw: number; tilt_deg: number; com: number[] };
    feet?: Record<Leg, Foot>
}
export type Intent = ObservationKey & {
    id: string; leg: Leg; kind: "wait" | "step"; duration: number; forward: number; clearance: number;
    target?: number[]; shift_ticks?: number; settle_ticks?: number; score?: number; reason?: string;
    earliest_tick?: number; valid_until_tick?: number
}
type ObservationKey = Pick<Observation, "episode" | "revision" | "tick" | "step">
export function pairedProfile(profile = "brisk") {
    if (!(profile in pairedProfiles)) throw new Error("Unknown paired motion profile")
    return pairedProfiles[profile as Profile]
}
export function validateGoal(goal: Goal, policy = "reactive", profile = "brisk"): Goal {
    const bounds = policy === "trot" ? pairedProfile(profile).velocity_limits : [.025, .015, .08]
    if (!goal || ![goal.vx, goal.vy, goal.yaw_rate].every(Number.isFinite) ||
        Math.abs(goal.vx) > bounds[0] || Math.abs(goal.vy) > bounds[1] || Math.abs(goal.yaw_rate) > bounds[2])
        throw new Error(`Goal limits: vx ±${bounds[0]} m/s, vy ±${bounds[1]} m/s, yaw ±${bounds[2]} rad/s`)
    return { vx: goal.vx, vy: goal.vy, yaw_rate: goal.yaw_rate }
}
export function propose(leg: Leg, obs: Observation): Intent {
    const policy = obs.policy ?? "fixed"
    if (obs.profile === "fast" && policy !== "trot") throw new Error("Fast timing requires diagonal pairs")
    const gait = policy === "trot" ? pairedProfile(obs.profile ?? "baseline") : null
    const timing = gait ? {shift_ticks: obs.step === 0 ? gait.initial_shift_ticks : gait.shift_ticks,
        settle_ticks: gait.settle_ticks, duration: gait.duration, clearance: gait.clearance} : PROFILES[(obs.profile ?? "baseline") as keyof typeof PROFILES]
    if (!timing || !["fixed", "reactive", "ordered", "trot"].includes(policy)) throw new Error("Unknown policy/profile")
    const intent: Intent = {
        episode: obs.episode, revision: obs.revision, tick: obs.tick, step: obs.step,
        id: `${obs.episode}.${obs.revision}.${leg}`, leg, kind: "wait", ...timing, forward: .05,
        earliest_tick: obs.tick, valid_until_tick: obs.tick + 5, score: 0, reason: "Fixed policy waits"
    }
    if (policy === "fixed") {
        intent.kind = ORDER[obs.step % 4] === leg ? "step" : "wait"
        return intent
    }
    const goal = validateGoal(obs.goal!, policy, obs.profile)
    if (!obs.feet || !obs.center || obs.formation_yaw === undefined || !obs.body) throw new Error("Missing physical observation")
    const foot = obs.feet[leg]
    if (Math.hypot(goal.vx, goal.vy, goal.yaw_rate) < 1e-8) return { ...intent, reason: "Zero velocity goal; maintain support" }
    if (Object.values(obs.feet).some(f => !f.contact || f.remaining_ticks > 0) || obs.body.tilt_deg > 8)
        return { ...intent, reason: "Waiting for planted feet and body stability" }
    const slotSeconds = timing.shift_ticks * .02 + timing.duration + timing.settle_ticks * .02 + .18
    // Preview a body pose. Each leg independently corrects its placement toward it.
    const horizon = gait ? gait.preview_seconds : 2.5 * slotSeconds
    const yaw = obs.reference_yaw ?? obs.formation_yaw
    const center = obs.reference_center?.length === 2 ? obs.reference_center : obs.center
    const c = Math.cos(yaw), s = Math.sin(yaw)
    const advance = [c * goal.vx - s * goal.vy, s * goal.vx + c * goal.vy]
    const nextYaw = yaw + Math.max(-.20, Math.min(.20, goal.yaw_rate * horizon))
    const target = [
        center[0] + advance[0] * horizon + Math.cos(nextYaw) * foot.nominal[0] - Math.sin(nextYaw) * foot.nominal[1],
        center[1] + advance[1] * horizon + Math.sin(nextYaw) * foot.nominal[0] + Math.cos(nextYaw) * foot.nominal[1],
        foot.position[2]
    ]
    const delta = target.map((x, i) => x - foot.position[i])
    const error = Math.hypot(delta[0], delta[1])
    const scale = Math.min(1, (gait?.step_limit ?? .07) / Math.max(error, 1e-9))
    intent.target = foot.position.map((x, i) => x + delta[i] * scale)
    intent.forward = 0
    // Placement error, waiting age, and the body shift required to unload this leg.
    intent.score = error + .006 * Math.min(8, obs.step - foot.last_step) - .10 * foot.shift_distance
    intent.reason = `Placement error ${(error * 100).toFixed(1)} cm; waiting ${obs.step - foot.last_step} placements`
    if (policy === "trot") {
        if (!PAIRS[obs.next_pair ?? 0]?.includes(leg)) return { ...intent, reason: "Supporting the opposite diagonal pair" }
        // Both members must consent; even a foot near its target participates in
        // the pair's common timing so a single-leg fallback cannot occur.
        return { ...intent, kind: "step", reason: `Diagonal ${PAIRS[obs.next_pair ?? 0].join(" + ")}; ${(error*100).toFixed(1)} cm placement correction` }
    }
    if (error < .005) return { ...intent, reason: "Foot already near its target" }
    if (policy === "ordered" && ORDER[obs.step % 4] !== leg) return intent
    intent.kind = "step"
    return intent
}
export function selectIntent(intents: Intent[]): Intent | null {
    return intents.filter(i => i.kind === "step").sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.leg.localeCompare(b.leg))[0] ?? null
}

export function selectIntents(intents: Intent[], policy = "reactive", nextPair = 0): Intent[] {
    if (policy !== "trot") {
        const single = selectIntent(intents)
        return single ? [single] : []
    }
    const pair = PAIRS[nextPair]
    if (!pair) throw new Error("Invalid diagonal phase")
    const chosen = pair.map(leg => intents.find(i => i.leg === leg && i.kind === "step"))
    if (chosen.some(i => !i)) return []
    const result = chosen as Intent[]
    if (result[0].duration !== result[1].duration || result[0].clearance !== result[1].clearance ||
        result[0].shift_ticks !== result[1].shift_ticks || result[0].settle_ticks !== result[1].settle_ticks)
        throw new Error("Diagonal partners disagree on timing")
    return result
}
