// No physics, credentials, or persistence: runs the exact actor policy for fast evaluations.
import { LEGS, propose, selectIntents } from "./src/policy"
for await (const line of console) {
    try {
        const obs = JSON.parse(line)
        const intents = LEGS.map(leg => propose(leg, obs))
        const selected = selectIntents(intents, obs.policy, obs.next_pair)
        console.log(JSON.stringify({ intents, selected, intent: selected[0] ?? null }))
    } catch (error) { console.log(JSON.stringify({ error: String(error) })) }
}
