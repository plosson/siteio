import { describe, expect, test } from "bun:test"
import {
  ENV_KEY_RE,
  MEMBER_EXTRA_ROUTE,
  parseEnvUpdate,
  readCookie,
  sanitizeChatTarget,
  scrubApp,
  TENANT_APP_ROUTE,
  TENANT_DENIED_ENV,
  TENANT_DENIED_ENV_PREFIXES,
  TENANT_ROUTE,
  VOLUME_NAME_RE,
} from "../../lib/agent/request-shaping.ts"
import type { App } from "../../types.ts"

function req(cookies?: string): Request {
  return new Request("https://api.example.test/", {
    headers: cookies ? { cookie: cookies } : {},
  })
}

describe("readCookie", () => {
  test("reads a simple cookie", () => {
    expect(readCookie(req("session=abc"), "session")).toBe("abc")
  })
  test("reads among several cookies with spaces", () => {
    expect(readCookie(req("a=1; session=abc; b=2"), "session")).toBe("abc")
  })
  test("percent-decodes the value", () => {
    expect(readCookie(req("session=a%20b%2Fc"), "session")).toBe("a b/c")
  })
  test("missing header → null", () => {
    expect(readCookie(req(), "session")).toBeNull()
  })
  test("absent name → null", () => {
    expect(readCookie(req("other=1"), "session")).toBeNull()
  })
  test("malformed value (bad encoding) → null, not a throw", () => {
    expect(readCookie(req("session=%E0%A4%A"), "session")).toBeNull()
  })
  test("empty value → empty string (still a value)", () => {
    expect(readCookie(req("session="), "session")).toBe("")
  })
  test("name matched exactly, not by prefix", () => {
    expect(readCookie(req("session_x=1"), "session")).toBeNull()
  })
})

describe("parseEnvUpdate", () => {
  test("accepts a well-formed update", () => {
    expect(parseEnvUpdate({ env: { A: "1" }, secrets: { B: "2" }, unsetEnv: ["C"] })).toEqual({
      env: { A: "1" },
      secrets: { B: "2" },
      unsetEnv: ["C"],
    })
  })
  test("accepts missing optional fields", () => {
    expect(parseEnvUpdate({ env: { A: "1" } })).toEqual({ env: { A: "1" }, secrets: undefined, unsetEnv: undefined })
  })
  test("rejects null, arrays and non-objects", () => {
    expect(parseEnvUpdate(null)).toBeNull()
    expect(parseEnvUpdate([])).toBeNull()
    expect(parseEnvUpdate("env")).toBeNull()
  })
  test("rejects unknown extra fields (client-sent secretKeys)", () => {
    expect(parseEnvUpdate({ env: {}, secretKeys: ["A"] })).toBeNull()
  })
  test("rejects non-string map values", () => {
    expect(parseEnvUpdate({ env: { A: 1 } })).toBeNull()
    expect(parseEnvUpdate({ env: ["A"] })).toBeNull()
  })
  test("rejects non-string unsetEnv entries", () => {
    expect(parseEnvUpdate({ unsetEnv: [1] })).toBeNull()
    expect(parseEnvUpdate({ unsetEnv: "A" })).toBeNull()
  })
})

describe("sanitizeChatTarget", () => {
  test("coerces an element target", () => {
    expect(sanitizeChatTarget({ kind: "element", selector: "#a", tag: "div", text: "hi" })).toEqual({
      kind: "element",
      selector: "#a",
      tag: "div",
      text: "hi",
    })
  })
  test("unknown kind falls back to element", () => {
    expect(sanitizeChatTarget({ selector: "#a" })?.kind).toBe("element")
  })
  test("text kind is preserved", () => {
    expect(sanitizeChatTarget({ kind: "text", text: "hello" })?.kind).toBe("text")
  })
  test("re-caps every string field beyond its limit", () => {
    const t = sanitizeChatTarget({ selector: "x".repeat(400), text: "y".repeat(600) })
    expect(t?.selector?.length).toBe(300)
    expect(t?.text?.length).toBe(500)
  })
  test("caps styles to 12 entries with capped key/value", () => {
    const styles: Record<string, string> = {}
    for (let i = 0; i < 20; i++) styles[`k${i}`] = "v"
    const t = sanitizeChatTarget({ selector: "#a", styles })
    expect(Object.keys(t?.styles ?? {}).length).toBe(12)
  })
  test("drops unknown fields", () => {
    const t = sanitizeChatTarget({ selector: "#a", evil: "nope" })
    expect("evil" in (t ?? {})).toBe(false)
  })
  test("no anchor (selector/text/outerHTML) → undefined", () => {
    expect(sanitizeChatTarget({ tag: "div" })).toBeUndefined()
    expect(sanitizeChatTarget({})).toBeUndefined()
    expect(sanitizeChatTarget("x")).toBeUndefined()
  })
})

describe("scrubApp", () => {
  const base = {
    name: "myapp",
    image: "nginx",
    port: 80,
    status: "running",
  } as unknown as App

  test("keeps non-secret env untouched", () => {
    const app = { ...base, env: { PUBLIC: "1" } } as App
    expect(scrubApp(app).env).toEqual({ PUBLIC: "1" })
  })
  test("masks env values for keys marked secret", () => {
    const app = { ...base, env: { PUBLIC: "1", TOKEN: "hunter2" }, secretKeys: ["TOKEN"] } as unknown as App
    const scrubbed = scrubApp(app)
    expect(scrubbed.env?.TOKEN).not.toBe("hunter2")
    expect(scrubbed.secretKeys).toEqual(["TOKEN"])
  })
  test("replaces a git token with tokenSet", () => {
    const app = { ...base, git: { repo: "https://x/y", ref: "main", token: "gh_secret" } } as unknown as App
    const scrubbed = scrubApp(app)
    expect(scrubbed.git?.token).toBeUndefined()
    expect(scrubbed.git?.tokenSet).toBe(true)
  })
  test("tokenSet false when no git token", () => {
    const app = { ...base, git: { repo: "https://x/y", ref: "main" } } as unknown as App
    expect(scrubApp(app).git?.tokenSet).toBe(false)
  })
  test("does not mutate the input app", () => {
    const app = { ...base, git: { repo: "https://x/y", ref: "main", token: "gh_secret" } } as unknown as App
    scrubApp(app)
    expect(app.git?.token).toBe("gh_secret")
  })
})

describe("tenant route policy", () => {
  test("tenant reaches core site routes", () => {
    expect(TENANT_ROUTE.test("/agent")).toBe(true)
    expect(TENANT_ROUTE.test("/sites")).toBe(true)
    expect(TENANT_ROUTE.test("/sites/my-site")).toBe(true)
    expect(TENANT_ROUTE.test("/sites/my-site/logs")).toBe(true)
    expect(TENANT_ROUTE.test("/sites/my-site/rollback")).toBe(true)
    expect(TENANT_ROUTE.test("/sites/my-site/grants")).toBe(true)
    expect(TENANT_ROUTE.test("/sites/my-site/grants/grt_abc123")).toBe(true)
  })
  test("tenant cannot reach operator-only routes", () => {
    expect(TENANT_ROUTE.test("/tenants")).toBe(false)
    expect(TENANT_ROUTE.test("/users")).toBe(false)
    expect(TENANT_ROUTE.test("/sites/my-site/chat")).toBe(false)
    expect(TENANT_ROUTE.test("/sites/my-site/edit-link")).toBe(false)
    expect(TENANT_ROUTE.test("/apps")).toBe(false)
    expect(TENANT_ROUTE.test("/auth/login")).toBe(false)
  })
  test("tenant app routes (when Tenant.apps)", () => {
    expect(TENANT_APP_ROUTE.test("/apps")).toBe(true)
    expect(TENANT_APP_ROUTE.test("/apps/my-app")).toBe(true)
    expect(TENANT_APP_ROUTE.test("/apps/my-app/deploy")).toBe(true)
    expect(TENANT_APP_ROUTE.test("/apps/my-app/status")).toBe(true)
    expect(TENANT_APP_ROUTE.test("/apps/my-app/env")).toBe(false)
    expect(TENANT_APP_ROUTE.test("/apps/my-app/chat")).toBe(false)
  })
  test("member extra routes (main-domain members only)", () => {
    expect(MEMBER_EXTRA_ROUTE.test("/sites/my-site/chat")).toBe(true)
    expect(MEMBER_EXTRA_ROUTE.test("/sites/my-site/chat/stop")).toBe(true)
    expect(MEMBER_EXTRA_ROUTE.test("/sites/my-site/edit-link")).toBe(true)
    expect(MEMBER_EXTRA_ROUTE.test("/sites/my-site/deploy")).toBe(false)
  })
  test("path traversal shapes are rejected", () => {
    expect(TENANT_ROUTE.test("/sites/../users")).toBe(false)
    expect(TENANT_ROUTE.test("/sites/My-Site")).toBe(false) // caps not allowed
    expect(TENANT_ROUTE.test("/sites/a/b/c")).toBe(false)
    expect(TENANT_APP_ROUTE.test("/apps/../tenants")).toBe(false)
  })
})

describe("tenant env/volume guards", () => {
  test("ENV_KEY_RE: valid and invalid keys", () => {
    expect(ENV_KEY_RE.test("MY_VAR")).toBe(true)
    expect(ENV_KEY_RE.test("_X")).toBe(true)
    expect(ENV_KEY_RE.test("9X")).toBe(false)
    expect(ENV_KEY_RE.test("MY-VAR")).toBe(false)
    expect(ENV_KEY_RE.test("MY VAR")).toBe(false)
  })
  test("TENANT_DENIED_ENV covers host-steering vars", () => {
    for (const key of ["PATH", "HOME", "HTTP_PROXY", "HTTPS_PROXY"]) expect(TENANT_DENIED_ENV.includes(key)).toBe(true)
  })
  test("TENANT_DENIED_ENV_PREFIXES covers loader/docker vars", () => {
    expect(TENANT_DENIED_ENV_PREFIXES.some((p) => "LD_PRELOAD".startsWith(p))).toBe(true)
    expect(TENANT_DENIED_ENV_PREFIXES.some((p) => "DOCKER_HOST".startsWith(p))).toBe(true)
    expect(TENANT_DENIED_ENV_PREFIXES.some((p) => "MY_APP".startsWith(p))).toBe(false)
  })
  test("VOLUME_NAME_RE: plain names only, no host paths", () => {
    expect(VOLUME_NAME_RE.test("data")).toBe(true)
    expect(VOLUME_NAME_RE.test("my.volume-1")).toBe(true)
    expect(VOLUME_NAME_RE.test("/etc")).toBe(false)
    expect(VOLUME_NAME_RE.test("../escape")).toBe(false)
    expect(VOLUME_NAME_RE.test("")).toBe(false)
  })
})
