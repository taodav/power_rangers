import { LEGS, type Leg } from './policy'

export type LegPlan = { offset: number; swing_s: number; clearance: number; forward_bias: number; lateral_bias: number; placement_gain: number; reason: string }
export type Decision = { request_id: string; leg: Leg; plan: LegPlan; response_id: string; model: string; usage: Record<string, unknown> }

export function validateLegPlan(p: LegPlan): void {
    if (!p || ![p.offset, p.swing_s, p.clearance, p.forward_bias, p.lateral_bias, p.placement_gain].every(Number.isFinite) ||
        p.offset < 0 || p.offset >= 1 || p.swing_s < .1 || p.swing_s > .18 || p.clearance < .03 || p.clearance > .06 ||
        Math.abs(p.forward_bias) > .015 || Math.abs(p.lateral_bias) > .008 || p.placement_gain < 0 || p.placement_gain > .08 ||
        typeof p.reason !== 'string' || p.reason.length > 500)
        throw new Error('Leg proposal exceeds the motion envelope')
}

export function validateDecisions(decisions: Decision[]): void {
    if (decisions.length !== 4 || new Set(decisions.map(d => d.leg)).size !== 4 || decisions.some(d => !LEGS.includes(d.leg)))
        throw new Error('Expected one proposal from each Ranger')
    decisions.forEach(d => validateLegPlan(d.plan))
    // No leg order, pair selection or minimum-contact rule: overlap is permitted.
}
