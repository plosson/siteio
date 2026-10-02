// src/__tests__/unit/auto-update.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, utimesSync, chmodSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { maybeAutoUpdate, type AutoUpdateDeps } from "../../commands/auto-update.ts"
import { getVersion } from "../../lib/version.ts"

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000
const realFetch = globalThis.fetch
const savedEnv = { ...process.env }

const [major, minor, patch] = getVersion().split(".").map(Number) as [number, number, number]
const nextMinor = `v${major}.${minor + 1}.0`
const nextMajor = `v${major + 1}.0.0`

describe("Unit: automatic update", () => {
  let dir: string
  let fetchCalls: number
  let installs: string[]
  let relaunches: number
  let exitCode: number | null

  /** releases/latest redirects to `tag`; the asset HEAD probe succeeds. */
  function releaseIs(tag: string): void {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      fetchCalls++
      if (url.endsWith("/releases/latest")) {
        return new Response(null, { status: 302, headers: { location: `https://github.com/plosson/siteio/releases/tag/${tag}` } })
      }
      if (url.includes("/releases/download/")) return new Response(null, { status: 200 })
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch
  }

  function deps(overrides: Partial<AutoUpdateDeps> = {}): AutoUpdateDeps {
    return {
      now: () => NOW,
      isRelease: () => true,
      execPath: join(dir, "bin", "siteio"),
      stateDir: join(dir, "config"),
      install: async (url) => {
        installs.push(url)
      },
      relaunch: async () => {
        relaunches++
        return 7
      },
      exit: ((code: number) => {
        exitCode = code
      }) as AutoUpdateDeps["exit"],
      ...overrides,
    }
  }

  const stateFile = () => join(dir, "config", "update-check.json")
  const lockFile = () => join(dir, "config", "update.lock")
  const lastCheck = () => (existsSync(stateFile()) ? JSON.parse(readFileSync(stateFile(), "utf-8")).lastCheck : null)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "siteio-auto-update-"))
    mkdirSync(join(dir, "bin"))
    mkdirSync(join(dir, "config"))
    writeFileSync(join(dir, "bin", "siteio"), "")
    delete process.env.CI
    delete process.env.SITEIO_NO_AUTO_UPDATE
    delete process.env.SITEIO_AUTO_UPDATED
    fetchCalls = 0
    installs = []
    relaunches = 0
    exitCode = null
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    process.env = { ...savedEnv }
    try {
      chmodSync(join(dir, "bin"), 0o755)
    } catch {}
    rmSync(dir, { recursive: true, force: true })
  })

  test("a newer minor release is installed and the command reruns with the child exit code", async () => {
    releaseIs(nextMinor)
    await maybeAutoUpdate(["sites", "list"], deps())
    expect(installs).toHaveLength(1)
    expect(installs[0]).toContain(`/releases/download/${nextMinor}/`)
    expect(relaunches).toBe(1)
    expect(exitCode).toBe(7)
    expect(lastCheck()).toBe(NOW)
  })

  test("a new major release is announced, never installed", async () => {
    releaseIs(nextMajor)
    await maybeAutoUpdate(["sites", "list"], deps())
    expect(installs).toHaveLength(0)
    expect(relaunches).toBe(0)
  })

  test("the same or an older release installs nothing", async () => {
    releaseIs(`v${major}.${minor}.${patch}`)
    await maybeAutoUpdate(["sites", "list"], deps())
    releaseIs(`v${Math.max(0, major - 1)}.0.0`)
    await maybeAutoUpdate(["sites", "list"], deps({ now: () => NOW + 2 * DAY }))
    expect(installs).toHaveLength(0)
    expect(relaunches).toBe(0)
  })

  test("a check less than 24h old does not touch the network", async () => {
    releaseIs(nextMinor)
    writeFileSync(stateFile(), JSON.stringify({ lastCheck: NOW - DAY + 1000 }))
    await maybeAutoUpdate(["sites", "list"], deps())
    expect(fetchCalls).toBe(0)
  })

  test("a check exactly 24h old is due again", async () => {
    releaseIs(nextMinor)
    writeFileSync(stateFile(), JSON.stringify({ lastCheck: NOW - DAY }))
    await maybeAutoUpdate(["sites", "list"], deps())
    expect(installs).toHaveLength(1)
  })

  test("a last check in the future (wrong clock) does not block updates forever", async () => {
    releaseIs(nextMinor)
    writeFileSync(stateFile(), JSON.stringify({ lastCheck: NOW + 365 * DAY }))
    await maybeAutoUpdate(["sites", "list"], deps())
    expect(installs).toHaveLength(1)
    expect(lastCheck()).toBe(NOW)
  })

  for (const [label, content] of [
    ["garbage", "not json{"],
    ["a string timestamp", JSON.stringify({ lastCheck: String(NOW) })],
    ["null", "null"],
  ] as const) {
    test(`a state file holding ${label} counts as never checked`, async () => {
      releaseIs(nextMinor)
      writeFileSync(stateFile(), content)
      await maybeAutoUpdate(["sites", "list"], deps())
      expect(installs).toHaveLength(1)
    })
  }

  test("a missing config folder is created, not an error", async () => {
    releaseIs(nextMinor)
    await maybeAutoUpdate(["sites", "list"], deps({ stateDir: join(dir, "fresh", "siteio") }))
    expect(installs).toHaveLength(1)
  })

  test("an unreachable GitHub never fails the command, and is not retried on the next call", async () => {
    globalThis.fetch = (async () => {
      fetchCalls++
      throw new TypeError("Unable to connect")
    }) as unknown as typeof fetch
    await maybeAutoUpdate(["sites", "list"], deps())
    expect(lastCheck()).toBe(NOW)
    const callsAfterFirst = fetchCalls
    await maybeAutoUpdate(["sites", "list"], deps({ now: () => NOW + 1000 }))
    expect(fetchCalls).toBe(callsAfterFirst)
    expect(relaunches).toBe(0)
  })

  test("a GitHub that never answers gives up instead of hanging the command", async () => {
    globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch
    const started = Date.now()
    await maybeAutoUpdate(["sites", "list"], deps())
    expect(Date.now() - started).toBeLessThan(5000)
    expect(installs).toHaveLength(0)
  }, 10000)

  test("a failed install runs the command on the current binary, without relaunching", async () => {
    releaseIs(nextMinor)
    await maybeAutoUpdate(["sites", "list"], deps({ install: async () => { throw new Error("disk full") } }))
    expect(relaunches).toBe(0)
    expect(exitCode).toBeNull()
    expect(existsSync(lockFile())).toBe(false)
  })

  test("a release with no binary for this platform installs nothing", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).endsWith("/releases/latest")) {
        return new Response(null, { status: 302, headers: { location: `https://github.com/plosson/siteio/releases/tag/${nextMinor}` } })
      }
      return new Response(null, { status: 404 })
    }) as typeof fetch
    await maybeAutoUpdate(["sites", "list"], deps())
    expect(installs).toHaveLength(0)
    expect(relaunches).toBe(0)
  })

  test("while another process holds a fresh lock, nothing is checked or installed", async () => {
    releaseIs(nextMinor)
    writeFileSync(lockFile(), "12345")
    await maybeAutoUpdate(["sites", "list"], deps({ now: () => Date.now() }))
    expect(fetchCalls).toBe(0)
    expect(existsSync(lockFile())).toBe(true)
  })

  test("a stale lock left by a crashed process is taken over and released", async () => {
    releaseIs(nextMinor)
    writeFileSync(lockFile(), "12345")
    const old = new Date(Date.now() - 60 * 60 * 1000)
    utimesSync(lockFile(), old, old)
    await maybeAutoUpdate(["sites", "list"], deps({ now: () => Date.now() }))
    expect(installs).toHaveLength(1)
    expect(existsSync(lockFile())).toBe(false)
  })

  test("concurrent commands install the update only once", async () => {
    releaseIs(nextMinor)
    await Promise.all(Array.from({ length: 5 }, () => maybeAutoUpdate(["sites", "list"], deps())))
    expect(installs).toHaveLength(1)
  })

  for (const commandPath of [["update"], ["agent", "start"], ["agent", "config", "set"]]) {
    test(`\`${commandPath.join(" ")}\` never auto-updates`, async () => {
      releaseIs(nextMinor)
      await maybeAutoUpdate(commandPath, deps())
      expect(fetchCalls).toBe(0)
    })
  }

  for (const env of ["SITEIO_NO_AUTO_UPDATE", "CI", "SITEIO_AUTO_UPDATED"]) {
    test(`${env} disables the automatic update`, async () => {
      releaseIs(nextMinor)
      process.env[env] = "1"
      await maybeAutoUpdate(["sites", "list"], deps())
      expect(fetchCalls).toBe(0)
    })
  }

  test("a non-release build (source or a compile without BUILD_VERSION) never replaces its binary", async () => {
    releaseIs(nextMinor)
    await maybeAutoUpdate(["sites", "list"], deps({ isRelease: () => false }))
    expect(fetchCalls).toBe(0)
  })

  test("a binary in a folder the user cannot write is left alone", async () => {
    if (process.getuid?.() === 0) return // root writes everywhere
    releaseIs(nextMinor)
    chmodSync(join(dir, "bin"), 0o555)
    await maybeAutoUpdate(["sites", "list"], deps())
    expect(fetchCalls).toBe(0)
  })
})
