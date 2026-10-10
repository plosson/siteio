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

  test("a real Traefik v3.7.13 access-log line becomes one pageview", async () => {
    const server = makeServer(url())
    await deploySite(server, "blog")
    // Captured verbatim; only the router and host are rewritten to a deployed site.
    const real = JSON.parse(
      String.raw`{"ClientAddr":"192.168.215.1:38902","ClientHost":"192.168.215.1","ClientPort":"38902","DownstreamContentSize":11,"DownstreamStatus":200,"Duration":2004838,"OriginContentSize":11,"OriginDuration":1896502,"OriginStatus":200,"Overhead":108336,"RequestAddr":"localhost:18930","RequestContentSize":0,"RequestCount":1,"RequestHost":"localhost","RequestMethod":"GET","RequestPath":"/x?y=1","RequestPort":"18930","RequestProtocol":"HTTP/1.1","RequestScheme":"http","RetryAttempts":0,"RouterName":"r1@file","ServiceAddr":"host.docker.internal:18931","ServiceName":"s1@file","ServiceURL":"http://host.docker.internal:18931","StartLocal":"2026-10-10T09:44:06.996895028Z","StartUTC":"2026-10-10T09:44:06.996895028Z","downstream_Content-Type":"text/html","entryPointName":"web","level":"info","msg":"","origin_Content-Type":"text/html","request_Cf-Connecting-Ip":"198.51.100.7","request_Referer":"https://ref.example/","request_User-Agent":"Mozilla/5.0 test","time":"2026-10-10T09:44:06Z"}`
    )
    real.RouterName = "siteio-blog@docker"
    real.RequestHost = "blog.analytics.test"
    writeLog(real)
    await server.analyticsTickForTest()
    expect(batches).toHaveLength(1)
    const pvs = batches[0]!.pageviews
    expect(pvs).toHaveLength(1)
    expect(pvs[0]!.userAgent).toBe("Mozilla/5.0 test")
    expect(pvs[0]!.referrer).toBe("https://ref.example/")
    expect(pvs[0]!.path).toBe("/x")
    expect(pvs[0]!.ip).toBe("192.168.215.1") // not a Cloudflare IP: the CF header is ignored
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
