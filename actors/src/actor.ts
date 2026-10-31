import { Actor, Ephemeral, Persisted } from "terse-sdk/actor"

import { LEGS, propose, selectIntents, validateGoal, pairedProfile, type Leg, type Observation, type Intent, type Goal } from "./policy"

type Checkpoint = {
    tick: number; backend: string; rig: boolean;
    crawl: { external_policy: boolean; phase: string; status: string; completed_steps: number; cycles: number; policy?: string; profile?: string; goal?: Goal; next_pair?: number };
    anchors: Record<Leg, number[]>;
    active: { action_id: string; leg: Leg; start_tick: number; deadline_tick: number }[]
}
type Event = { tick: number; kind: string; leg: string | null; detail: string }
type Pending = { id: string; revision: number; intent: Intent | null; intents?: Intent[]; stop: boolean }
type Session = {
    episode: string; revision: number; checkpoint: string; pending: Pending | null;
    last_commit: string | null; last_goal_revision?: number; last_goal?: string; stop: boolean; timeline: Event[]; intents: Intent[]
}
function checkpoint(value: string): Checkpoint {
    const cp = JSON.parse(value) as Checkpoint
    if (!Number.isSafeInteger(cp.tick) || cp.tick < 0 || cp.backend !== "native" || cp.rig || !cp.crawl?.external_policy)
        throw new Error("Expected a native, free-body actor checkpoint")
    return cp
}

/** Four instances of this class: one per leg. Gait knowledge lives here. */
export class Ranger extends Actor {
    @Persisted private memory = ""
    @Ephemeral private activation = crypto.randomUUID()

    async propose(observation: string): Promise<string> {
        const obs = JSON.parse(observation) as Observation
        const leg = this.id.split(".").at(-1) as Leg
        if (!LEGS.includes(leg) || !Number.isSafeInteger(obs.revision) || !Number.isSafeInteger(obs.step))
            throw new Error("Invalid Ranger observation")
        const previous = this.memory ? JSON.parse(this.memory) as { intent: Intent; decisions: number; observation?: string } : null
        if (previous && previous.intent.episode !== obs.episode) throw new Error("Ranger episode mismatch")
        if (previous && previous.intent.revision > obs.revision) throw new Error("Stale Ranger observation")
        if (previous?.intent.revision === obs.revision) {
            if (previous.intent.tick !== obs.tick || previous.intent.step !== obs.step || (previous.observation && previous.observation !== observation)) throw new Error("Conflicting observation retry")
            return JSON.stringify(previous.intent)
        }
        const intent = propose(leg, obs)
        // A single assignment atomically saves both the decision and its counter.
        this.memory = JSON.stringify({ intent, observation, decisions: (previous?.decisions ?? 0) + 1 })
        return JSON.stringify(intent)
    }

    async inspect(): Promise<string> {
        return JSON.stringify({ leg: this.id.split(".").at(-1), activation: this.activation,
            ...(this.memory ? JSON.parse(this.memory) : { intent: null, decisions: 0 }) })
    }
}

/** Durable arbiter: validates versions and atomically reserves a step or diagonal pair. */
export class Body extends Actor {
    @Persisted private record = ""
    @Ephemeral private activation = crypto.randomUUID()

    async initialize(initial: string): Promise<string> {
        if (this.record) return this.record
        const cp = checkpoint(initial)
        if (cp.tick !== 0 || cp.crawl.phase !== "awaiting_decision") throw new Error("Expected a fresh episode")
        const state: Session = { episode: this.id, revision: 0, checkpoint: initial, pending: null,
            last_commit: null, stop: false, intents: [],
            timeline: [{ tick: 0, kind: "episode", leg: null, detail: `Four ${cp.crawl.policy ?? "fixed"} Rangers; actuator-only balance` }] }
        this.record = JSON.stringify(state)
        return this.record
    }

    async inspect(): Promise<string> {
        if (!this.record) throw new Error("Body has no episode")
        return this.record
    }

    async identity(): Promise<string> { return JSON.stringify({ activation: this.activation }) }

    async prepare(revision: number, proposals: string): Promise<string> {
        if (!this.record) throw new Error("Body has no episode")
        const state = JSON.parse(this.record) as Session
        if (revision !== state.revision) throw new Error("Stale Body revision")
        if (state.pending) return JSON.stringify(state.pending)
        const cp = checkpoint(state.checkpoint)
        const gait = cp.crawl.policy === "trot" ? pairedProfile(cp.crawl.profile) : null
        if (cp.crawl.status !== "running") throw new Error("Episode has ended")
        const intents = JSON.parse(proposals) as Intent[]
        let accepted: Intent[] = []
        const events: Event[] = []
        if (cp.crawl.phase === "awaiting_decision" && !state.stop) {
            if (!Array.isArray(intents) || intents.length !== 4 || new Set(intents.map(i => i.leg)).size !== 4)
                throw new Error("A decision round needs four distinct Rangers")
            for (const intent of intents) {
                if (!LEGS.includes(intent.leg) || intent.episode !== this.id || intent.revision !== revision ||
                    intent.tick !== cp.tick || intent.step !== cp.crawl.completed_steps ||
                    intent.id !== `${this.id}.${revision}.${intent.leg}` || !["step", "wait"].includes(intent.kind))
                    throw new Error("Stale or invalid Ranger intent")
                if (![intent.duration, intent.forward, intent.clearance].every(Number.isFinite) ||
                    intent.duration < .2 || intent.duration > 2 || Math.abs(intent.forward) > .08 ||
                    intent.clearance < .015 || intent.clearance > .08) throw new Error("Motion limits exceeded")
            }
            for (const intent of intents) {
                if (intent.earliest_tick !== undefined && intent.earliest_tick > cp.tick ||
                    intent.valid_until_tick !== undefined && intent.valid_until_tick < cp.tick)
                    throw new Error("Intent validity window expired")
                if (intent.score !== undefined && (!Number.isFinite(intent.score) || Math.abs(intent.score) > 10))
                    throw new Error("Invalid intent priority")
                if (intent.target !== undefined && (!Array.isArray(intent.target) || intent.target.length !== 3 ||
                    !intent.target.every(Number.isFinite) ||
                    Math.hypot(...intent.target.map((v, i) => v - cp.anchors[intent.leg][i])) > (gait?.workspace ?? .085)))
                    throw new Error("Foot target exceeds step workspace")
                if (intent.shift_ticks !== undefined && (!Number.isInteger(intent.shift_ticks) || intent.shift_ticks < (gait?.shift_ticks ?? 20) || intent.shift_ticks > 100) ||
                    intent.settle_ticks !== undefined && (!Number.isInteger(intent.settle_ticks) || intent.settle_ticks < (gait?.settle_ticks ?? 5) || intent.settle_ticks > 30))
                    throw new Error("Invalid support-transfer timing")
                if (cp.crawl.policy === "trot" && intent.kind === "step" &&
                    (!intent.target || intent.duration > .4 || intent.clearance > .04))
                    throw new Error("Paired motion limits exceeded")
            }
            accepted = selectIntents(intents, cp.crawl.policy, cp.crawl.next_pair)
            if (!accepted.length) events.push({ tick: cp.tick, kind: "hold", leg: null, detail: "No complete eligible reservation; maintain support for a timed hold" })
            if (accepted.length === 2) events.push({ tick: cp.tick, kind: "pair_reserved", leg: accepted.map(i=>i.leg).join(" + "),
                detail: "Atomic diagonal reservation; shared start tick after support alignment; wait for both touchdowns" })
            for (const intent of intents) events.push({ tick: cp.tick, kind: accepted.includes(intent) ? "reserved" : "wait",
                leg: intent.leg, detail: accepted.includes(intent) ? `${intent.id}: ${intent.duration}s swing; support gate first` :
                    intent.kind === "step" ? "Waiting for the complete eligible reservation" : intent.reason ?? "Policy waits" })
            state.intents = intents
        } else if (intents.length) throw new Error("Executor is busy; new steps are not accepted")
        state.pending = { id: `${this.id}.${revision}`, revision, intent: accepted[0] ?? null, intents: accepted, stop: state.stop }
        state.timeline = [...state.timeline, ...events].slice(-400)
        this.record = JSON.stringify(state)
        return JSON.stringify(state.pending)
    }

    async commit(roundId: string, nextCheckpoint: string, eventJson: string): Promise<string> {
        if (!this.record) throw new Error("Body has no episode")
        const state = JSON.parse(this.record) as Session
        if (state.last_commit === roundId) {
            if (state.checkpoint !== nextCheckpoint) throw new Error("Conflicting commit retry")
            return this.record
        }
        if (state.pending?.id !== roundId) throw new Error("No matching prepared round")
        const before = checkpoint(state.checkpoint), after = checkpoint(nextCheckpoint)
        if (after.tick < before.tick || after.tick > before.tick + 5) throw new Error("Checkpoint exceeds 100ms round")
        const events = JSON.parse(eventJson) as Event[]
        if (!Array.isArray(events) || events.some(e => e.tick < before.tick || e.tick > after.tick)) throw new Error("Invalid event times")
        state.checkpoint = nextCheckpoint
        state.revision += 1
        state.last_commit = roundId
        state.pending = null
        state.timeline = [...state.timeline, ...events].slice(-400)
        // Checkpoint, revision, acknowledgement and timeline commit together.
        this.record = JSON.stringify(state)
        return this.record
    }

    async setGoal(revision: number, goalJson: string): Promise<string> {
        if (!this.record) throw new Error("Body has no episode")
        const state = JSON.parse(this.record) as Session
        const cp = checkpoint(state.checkpoint)
        const goal = validateGoal(JSON.parse(goalJson), cp.crawl.policy, cp.crawl.profile)
        const canonical = JSON.stringify(goal)
        if (state.last_goal_revision === revision && state.last_goal === canonical) return this.record
        if (state.revision !== revision || state.pending) throw new Error("Flush the current round before changing goals")
        if (cp.crawl.policy === "fixed" || !cp.crawl.policy) throw new Error("Velocity goals require reactive Rangers")
        if (cp.crawl.status !== "running" || state.stop) throw new Error("Episode has ended or is stopping")
        cp.crawl.goal = goal
        state.checkpoint = JSON.stringify(cp)
        state.last_goal_revision = revision
        state.last_goal = canonical
        state.revision += 1
        state.timeline = [...state.timeline, { tick: cp.tick, kind: "goal", leg: null, detail: canonical }].slice(-400)
        this.record = JSON.stringify(state)
        return this.record
    }

    async requestStop(): Promise<string> {
        if (!this.record) throw new Error("Body has no episode")
        const state = JSON.parse(this.record) as Session
        state.stop = true
        this.record = JSON.stringify(state)
        return this.record
    }
}
