import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync } from "fflate"
import { AgentServer } from "../../lib/agent/server.ts"
import { FakeRuntime } from "../helpers/fake-runtime.ts"
import type { AgentConfig } from "../../types.ts"

function makeServer(dataDir: string, runtime: FakeRuntime): AgentServer {
  const config: AgentConfig = {
    apiKey: "test-key", dataDir, domain: "example.com",
    maxUploadSize: 50 * 1024 * 1024, httpPort: 8080, httpsPort: 8443, skipTraefik: true,
  }
  return new AgentServer(config, runtime)
}

const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url")
const H = { "X-API-Key": "test-key", "Content-Type": "application/zip" }

describe("API: pocket OAuth relay", () => {
  let dataDir: string
  let runtime: FakeRuntime
  let server: AgentServer

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "siteio-relay-"))
    runtime = new FakeRuntime()
    server = makeServer(dataDir, runtime)
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  const deployBlog = () =>
    server.handleRequestForTest(new Request("http://x/pockets/blog", {
      method: "POST", headers: H, body: zipSync({ "public/index.html": new TextEncoder().encode("x") }),
    }))

  const call = (qs: string) =>
    server.handleRequestForTest(new Request(`http://x/pocket/oauth/callback?${qs}`, { method: "GET" }))

  test("bounces the code back to the target pocket", async () => {
    await deployBlog()
    const state = b64url({ p: "blog", c: "csrf1" })
    const res = await call(`code=abc123&state=${state}`)
    expect(res.status).toBe(302)
    const loc = new URL(res.headers.get("Location")!)
    expect(loc.origin).toBe("https://blog.example.com")
    expect(loc.searchParams.get("code")).toBe("abc123")
    expect(loc.searchParams.get("__pocket_oauth")).toBe("1")
    expect(loc.searchParams.get("state")).toBe(state)
  })

  test("is public — no API key required", async () => {
    await deployBlog()
    const res = await call(`code=x&state=${b64url({ p: "blog" })}`)
    expect(res.status).toBe(302) // not 401
  })

  test("rejects state pointing at a non-existent pocket (no open redirect)", async () => {
    const res = await call(`code=x&state=${b64url({ p: "evil" })}`)
    expect(res.status).toBe(400)
  })

  test("rejects a bogus pocket name in state", async () => {
    await deployBlog()
    const res = await call(`code=x&state=${b64url({ p: "../evil.com" })}`)
    expect(res.status).toBe(400)
  })

  test("rejects malformed state", async () => {
    const res = await call(`code=x&state=not-valid-base64url-json`)
    expect(res.status).toBe(400)
  })

  test("propagates a provider error back to the pocket", async () => {
    await deployBlog()
    const res = await call(`error=access_denied&state=${b64url({ p: "blog" })}`)
    expect(res.status).toBe(302)
    const loc = new URL(res.headers.get("Location")!)
    expect(loc.origin).toBe("https://blog.example.com")
    expect(loc.searchParams.get("error")).toBe("access_denied")
  })
})
