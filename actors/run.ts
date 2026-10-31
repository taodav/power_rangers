// Embedded official Terse local runtime. No dotenv loading or hosted credentials.
import { startLocalActors } from "terse-sdk/dev"
const runtime = await startLocalActors({
    project: import.meta.dir, entrypoint: "src/actor.ts", projectId: "power-rangers",
    port: Number(process.env.RANGERS_ACTOR_PORT ?? 7100),
    dataDir: process.env.RANGERS_ACTOR_DATA ?? ".durable-actors",
    apiKey: process.env.RANGERS_ACTOR_SECRET, quiet: false
})
console.log(JSON.stringify({ ready: true, projectId: runtime.connection.projectId,
    controlPlaneUrl: runtime.connection.controlPlaneUrl, pid: runtime.connection.pid }))
let stopping = false
async function stop() {
    if (stopping) return
    stopping = true
    await runtime.stop()
    process.exit(0)
}
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
runtime.closed.catch(error => { console.error(String(error)); process.exit(1) })
