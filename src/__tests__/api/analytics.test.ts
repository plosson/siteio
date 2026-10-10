import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "fs"
import { dirname, join } from "path"
import { tmpdir } from "os"
import { zipSync } from "fflate"
import { AgentServer } from "../../lib/agent/server"
import { accessLogPath } from "../../lib/agent/traefik"
import { FakeRuntime } from "../helpers/fake-runtime"
import type { AgentConfig, AnalyticsBatch } from "../../types"

const API_KEY = "analytics-test-key"

let batches: AnalyticsBatch[]
let status: number
let hang: boolean
let endpoint: ReturnType<typeof Bun.serve>
let dir: string

beforeEach(() => {
  batches = []
  status = 202
  hang = false
  endpoint = Bun.serve({
    port: 0,
    async fetch(req) {
      if (hang) await new Promise(() => {})
      batches.push((await req.json()) as AnalyticsBatch)
      return new Response("{}", { status })
    },
  })
  dir = mkdtempSync(join(tmpdir(), "siteio-analytics-"))
})

afterEach(() => {
  endpoint.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

function makeServer(analyticsUrl: string | undefined): AgentServer {
  const config: AgentConfig = {
    apiKey: API_KEY,
    dataDir: join(dir, "data"),
    domain: "analytics.test",
    maxUploadSize: 1024 * 1024,
    httpPort: 80,
    httpsPort: 443,
    skipTraefik: true,
    analyticsUrl,
  }
  return new AgentServer(config, new FakeRuntime())
}

const url = () => `http://localhost:${endpoint.port}/api/ingest?key=s3cret`

async function deploySite(server: AgentServer, name: string): Promise<void> {
  const zip = zipSync({ "public/index.html": new TextEncoder().encode("<h1>hi</h1>") })
  const res = await server.handleRequestForTest(
    new Request(`http://localhost/sites/${name}`, {
      method: "POST",
      headers: { "X-API-Key": API_KEY, "Content-Type": "application/zip", "X-Siteio-User": "pierre" },
      body: zip,
    })
  )
  expect(res.status).toBe(200)
}

function writeLog(...lines: Record<string, unknown>[]): void {
  const path = accessLogPath(join(dir, "data"))
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, lines.map((l) => JSON.stringify(l) + "\n").join(""))
}

const hit = (over: Record<string, unknown> = {}) => ({
  StartUTC: "2026-10-10T12:00:03Z",
  RouterName: "siteio-blog@docker",
  RequestMethod: "GET",
  RequestHost: "blog.analytics.test",
  RequestPath: "/?code=SECRET",
  DownstreamStatus: 200,
  DownstreamContentSize: 10,
  Duration: 1_000_000,
  ClientHost: "203.0.113.9",
  "request_User-Agent": "Mozilla/5.0 Firefox/130.0",
  "downstream_Content-Type": "text/html",
  ...over,
})

describe("analytics", () => {
  test("no analyticsUrl: no tick, no file needed, nothing sent", async () => {
    const server = makeServer(undefined)
    await server.analyticsTickForTest()
    expect(batches).toHaveLength(0)
    expect(existsSync(accessLogPath(join(dir, "data")))).toBe(false)
  })

  test("a pageview on a deployed site reaches the endpoint with its owner, secret query stripped", async () => {
    const server = makeServer(url())
    await deploySite(server, "blog")
    writeLog(hit(), hit({ RouterName: "api-router@file" }))
    await server.analyticsTickForTest()
    expect(batches).toHaveLength(1)
    const b = batches[0]!
    expect(b.agent).toBe("analytics.test")
    expect(b.pageviews).toHaveLength(1)
    expect(b.pageviews[0]!.owner).toBe("pierre")
    expect(b.pageviews[0]!.path).toBe("/")
    expect(JSON.stringify(b)).not.toContain("SECRET")
    expect(b.traffic).toHaveLength(1) // the api-router line is ignored
  })

  test("lines are sent once: a second tick with no new lines sends nothing", async () => {
    const server = makeServer(url())
    await deploySite(server, "blog")
    writeLog(hit())
    await server.analyticsTickForTest()
    await server.analyticsTickForTest()
    expect(batches).toHaveLength(1)
  })

  test("a deleted site's lines are dropped, not sent with a stale name", async () => {
    const server = makeServer(url())
    writeLog(hit({ RouterName: "siteio-ghost@docker" }))
    await server.analyticsTickForTest()
    expect(batches).toHaveLength(0)
  })

  test("an endpoint returning 500 does not break the next batch", async () => {
    const server = makeServer(url())
    await deploySite(server, "blog")
    status = 500
    writeLog(hit())
    await server.analyticsTickForTest()
    status = 202
    writeLog(hit())
    await server.analyticsTickForTest()
    expect(batches).toHaveLength(2) // both arrived; the 500 was logged, not retried
  })

  test("the agent keeps serving API requests while the endpoint hangs", async () => {
    const server = makeServer(url())
    await deploySite(server, "blog")
    hang = true
    writeLog(hit())
    void server.analyticsTickForTest()
    const res = await server.handleRequestForTest(
      new Request("http://localhost/sites", { headers: { "X-API-Key": API_KEY } })
    )
    expect(res.status).toBe(200)
  })
})
