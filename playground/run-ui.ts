#!/usr/bin/env bun
// Quick local run for poking at the admin UI.
// Starts an AgentServer with skipTraefik and a temp data dir.
// Open http://localhost:3333/ui in your browser.

import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { AgentServer } from "../src/lib/agent/server"

const dataDir = mkdtempSync(join(tmpdir(), "siteio-ui-local-"))
const apiKey = "dev-key"

const server = new AgentServer({
  domain: "localhost.test",
  apiKey,
  dataDir,
  port: 3333,
  skipTraefik: true,
  maxUploadSize: 50 * 1024 * 1024,
  httpPort: 80,
  httpsPort: 443,
})

await server.start()

// Seed some fake apps and groups so the UI isn't empty
await fetch("http://127.0.0.1:3333/apps", {
  method: "POST",
  headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
  body: JSON.stringify({ name: "nginx-demo", image: "nginx:alpine", internalPort: 80 }),
})
await fetch("http://127.0.0.1:3333/apps", {
  method: "POST",
  headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "redis-demo",
    image: "redis:7-alpine",
    internalPort: 6379,
    env: { REDIS_PASSWORD: "hunter2" },
    restartPolicy: "always",
  }),
})
await fetch("http://127.0.0.1:3333/groups", {
  method: "POST",
  headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
  body: JSON.stringify({ name: "engineers", emails: ["a@example.com", "b@example.com"] }),
})

console.log("")
console.log("  UI:      http://localhost:3333/ui")
console.log("  API Key: " + apiKey)
console.log("  Data:    " + dataDir)
console.log("")
console.log("Ctrl+C to stop.")

process.on("SIGINT", () => { server.stop(); process.exit(0) })
