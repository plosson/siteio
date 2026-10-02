import { describe, expect, test } from "bun:test"
import { AutoDeployer, parseAutoDeployInterval, type AutoDeployDeps, type RemoteRef } from "../../lib/agent/auto-deploy"
import type { App, AutoDeployMode } from "../../types"

const INTERVAL = 300_000
const HOUR = 3_600_000
const A = "a".repeat(40)
const B = "b".repeat(40)

function makeApp(mode: AutoDeployMode | undefined, extra: Partial<App> = {}): App {
  return {
    name: "web",
    type: "container",
    image: "siteio-web:latest",
    git: { repoUrl: "https://x.test/r.git", branch: "main", dockerfile: "Dockerfile", ...(mode && { autoDeploy: mode }) },
    env: {},
    volumes: [],
    internalPort: 3000,
    restartPolicy: "unless-stopped",
    domains: [],
    status: "running",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...extra,
  }
}

function tagRefs(...names: string[]): RemoteRef[] {
  return names.map((n, i) => ({ ref: `refs/tags/${n}`, sha: String(i).padStart(40, "0") }))
}

function harness(initial: App[]) {
  const apps = new Map(initial.map((a) => [a.name, a]))
  const state = {
    apps,
    refs: [] as RemoteRef[],
    lsError: null as Error | null,
    lsCalls: 0,
    deployError: null as Error | null,
    deploys: [] as Array<{ name: string; ref?: string }>,
    deploying: new Set<string>(),
    now: 1_000_000,
    logs: [] as string[],
    staleList: null as App[] | null,
  }
  const deps: AutoDeployDeps = {
    listApps: () => state.staleList ?? [...apps.values()],
    getApp: (n) => apps.get(n) ?? null,
    updateApp: (n, patch) => {
      const a = apps.get(n)
      if (a) apps.set(n, { ...a, ...patch })
    },
    lsRemote: async () => {
      state.lsCalls++
      if (state.lsError) throw state.lsError
      return state.refs
    },
    deploy: async (name, ref) => {
      state.deploys.push({ name, ref })
      if (state.deployError) throw state.deployError
      const a = apps.get(name)!
      if (!ref) apps.set(name, { ...a, commitHash: state.refs.find((r) => r.ref === "refs/heads/main")?.sha })
    },
    isDeploying: (n) => state.deploying.has(n),
    log: (line) => state.logs.push(line),
    now: () => state.now,
    random: () => 0, // first check is due at once
  }
  const deployer = new AutoDeployer(deps, INTERVAL)
  const app = () => apps.get("web")!
  return { state, deployer, app }
}

describe("tag mode", () => {
  test("first check deploys the highest release tag", async () => {
    const { state, deployer, app } = harness([makeApp("tag")])
    state.refs = tagRefs("v1.0.0", "v1.10.0", "v1.9.9", "v2.0.0-rc1")
    await deployer.tick()
    expect(state.deploys).toEqual([{ name: "web", ref: "v1.10.0" }])
    expect(app().autoDeployRef).toBe("v1.10.0")
    expect(app().autoDeployCheckedAt).toBe(new Date(1_000_000).toISOString())
  })

  test("no downgrade when only lower tags exist", async () => {
    const { state, deployer } = harness([makeApp("tag", { autoDeployRef: "v2.0.0" })])
    state.refs = tagRefs("v1.10.0")
    await deployer.tick()
    expect(state.deploys).toEqual([])
  })

  test("restart does not redeploy", async () => {
    const { state, deployer } = harness([makeApp("tag", { autoDeployRef: "v1.10.0" })])
    state.refs = tagRefs("v1.0.0", "v1.10.0")
    await deployer.tick()
    expect(state.deploys).toEqual([])
  })

  test("a failed tag is not retried, and the error survives later checks", async () => {
    const { state, deployer, app } = harness([makeApp("tag")])
    state.refs = tagRefs("v1.0.0")
    state.deployError = new Error("docker build failed")
    await deployer.tick()
    expect(app().autoDeployError).toBe("deploy failed for v1.0.0: docker build failed")

    state.deployError = null
    state.now += INTERVAL
    await deployer.tick()
    expect(state.lsCalls).toBe(2)
    expect(state.deploys).toHaveLength(1)
    expect(app().autoDeployError).toBe("deploy failed for v1.0.0: docker build failed")
  })

  test("a newer tag after a failure is deployed", async () => {
    const { state, deployer } = harness([makeApp("tag")])
    state.refs = tagRefs("v1.0.0")
    state.deployError = new Error("boom")
    await deployer.tick()
    state.deployError = null
    state.refs = tagRefs("v1.0.0", "v1.0.1")
    state.now += INTERVAL
    await deployer.tick()
    expect(state.deploys.map((d) => d.ref)).toEqual(["v1.0.0", "v1.0.1"])
  })

  test("no release tag", async () => {
    const { state, deployer, app } = harness([makeApp("tag")])
    state.refs = tagRefs("v1.0.0-rc1")
    await deployer.tick()
    expect(state.deploys).toEqual([])
    expect(app().autoDeployError).toBe("no vX.Y.Z tag found")
    state.now += INTERVAL // normal interval, no backoff
    await deployer.tick()
    expect(state.lsCalls).toBe(2)
  })
})

describe("commit mode", () => {
  test("the deployed commit does not redeploy", async () => {
    const { state, deployer } = harness([makeApp("commit", { commitHash: A })])
    state.refs = [{ ref: "refs/heads/main", sha: A }]
    await deployer.tick()
    expect(state.deploys).toEqual([])
  })

  test("a new commit deploys the branch, with no ref", async () => {
    const { state, deployer, app } = harness([makeApp("commit", { commitHash: A })])
    state.refs = [{ ref: "refs/heads/main", sha: B }]
    await deployer.tick()
    expect(state.deploys).toEqual([{ name: "web", ref: undefined }])
    expect(app().autoDeployRef).toBe(B)
  })

  test("a failed commit is not retried", async () => {
    const { state, deployer } = harness([makeApp("commit", { commitHash: A })])
    state.refs = [{ ref: "refs/heads/main", sha: B }]
    state.deployError = new Error("boom")
    await deployer.tick()
    state.now += INTERVAL
    await deployer.tick()
    expect(state.deploys).toHaveLength(1)
  })

  test("a missing branch is reported without a deploy", async () => {
    const { state, deployer, app } = harness([makeApp("commit", { commitHash: A })])
    state.refs = []
    await deployer.tick()
    expect(state.deploys).toEqual([])
    expect(app().autoDeployError).toBe("branch 'main' not found")
  })
})

describe("failed checks", () => {
  test("record the error and back off, doubling up to one hour", async () => {
    const { state, deployer, app } = harness([makeApp("tag")])
    state.lsError = new Error("Repository not found (or token lacks access): https://x.test/r.git")
    await deployer.tick()
    expect(app().autoDeployError).toBe("check failed: Repository not found (or token lacks access): https://x.test/r.git")

    state.now += INTERVAL // backoff is 2 intervals: not due yet
    await deployer.tick()
    expect(state.lsCalls).toBe(1)
    state.now += INTERVAL
    await deployer.tick()
    expect(state.lsCalls).toBe(2)

    for (let i = 0; i < 10; i++) {
      state.now += HOUR
      await deployer.tick()
    }
    expect(state.lsCalls).toBe(12) // never waits more than an hour
  })

  test("a successful check clears a check error and resets the interval", async () => {
    const { state, deployer, app } = harness([makeApp("tag", { autoDeployRef: "v1.0.0" })])
    state.lsError = new Error("network down")
    await deployer.tick()
    state.lsError = null
    state.refs = tagRefs("v1.0.0")
    state.now += 2 * INTERVAL
    await deployer.tick()
    expect(app().autoDeployError).toBeUndefined()
    state.now += INTERVAL
    await deployer.tick()
    expect(state.lsCalls).toBe(3)
  })
})

describe("stale errors", () => {
  test("a fresh deployer clears a stored check error on a healthy check", async () => {
    const { state, deployer, app } = harness([makeApp("tag", { autoDeployRef: "v1.0.0", autoDeployError: "check failed: x" })])
    state.refs = tagRefs("v1.0.0")
    await deployer.tick()
    expect(app().autoDeployError).toBeUndefined()
  })

  test("a no-target error clears once the target reappears with nothing to deploy", async () => {
    const { state, deployer, app } = harness([makeApp("tag", { autoDeployRef: "v1.0.0" })])
    state.refs = tagRefs("v1.0.0-rc1")
    await deployer.tick()
    expect(app().autoDeployError).toBe("no vX.Y.Z tag found")
    state.refs = tagRefs("v1.0.0")
    state.now += INTERVAL
    await deployer.tick()
    expect(app().autoDeployError).toBeUndefined()
  })
})

describe("listing failures", () => {
  test("a throwing listApps is logged and the next tick works", async () => {
    const { state, deployer } = harness([makeApp("tag")])
    state.refs = tagRefs("v1.0.0")
    const deps = (deployer as unknown as { deps: AutoDeployDeps }).deps
    const original = deps.listApps
    deps.listApps = () => {
      throw new Error("ENOENT")
    }
    await deployer.tick()
    expect(state.logs).toContain("auto-deploy: ENOENT")
    deps.listApps = original
    await deployer.tick()
    expect(state.lsCalls).toBe(1)
  })
})

describe("races and skips", () => {
  test("lock race: a 409 from deploy restores the previous ref and retries next tick", async () => {
    const { state, deployer, app } = harness([makeApp("tag", { autoDeployRef: "v1.0.0" })])
    state.refs = tagRefs("v1.0.0", "v1.1.0")
    state.deployError = Object.assign(new Error("Deploy already in progress"), { status: 409 })
    await deployer.tick()
    expect(app().autoDeployRef).toBe("v1.0.0")
    expect(app().autoDeployError).toBeUndefined()

    state.deployError = null
    state.now += INTERVAL
    await deployer.tick()
    expect(state.deploys.map((d) => d.ref)).toEqual(["v1.1.0", "v1.1.0"])
    expect(app().autoDeployRef).toBe("v1.1.0")
  })

  test("an app being deployed is skipped and checked on the next tick", async () => {
    const { state, deployer } = harness([makeApp("tag")])
    state.refs = tagRefs("v1.0.0")
    state.deploying.add("web")
    await deployer.tick()
    expect(state.lsCalls).toBe(0)
    state.deploying.clear()
    await deployer.tick() // still due: no interval wait
    expect(state.lsCalls).toBe(1)
  })

  test("an app switched off between listing and acting is skipped", async () => {
    const { state, deployer } = harness([makeApp("off")])
    state.staleList = [makeApp("tag")]
    await deployer.tick()
    expect(state.lsCalls).toBe(0)
  })

  test("an app deleted between listing and acting is skipped", async () => {
    const { state, deployer } = harness([])
    state.staleList = [makeApp("tag")]
    await deployer.tick()
    expect(state.lsCalls).toBe(0)
  })

  test("off, missing mode, image and compose apps are never checked", async () => {
    const { state, deployer } = harness([
      makeApp("off", { name: "a" }),
      makeApp(undefined, { name: "b" }),
      { ...makeApp(undefined, { name: "c" }), git: undefined },
      makeApp("tag", { name: "d", compose: { source: "git", path: "dc.yml", primaryService: "web" } }),
    ])
    await deployer.tick()
    expect(state.lsCalls).toBe(0)
  })

  test("overlapping ticks run one check", async () => {
    const { state, deployer } = harness([makeApp("tag")])
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const deps = (deployer as unknown as { deps: AutoDeployDeps }).deps
    const original = deps.lsRemote
    deps.lsRemote = async (...args) => {
      await gate
      return original(...args)
    }
    const first = deployer.tick()
    const second = deployer.tick()
    release()
    await Promise.all([first, second])
    expect(state.lsCalls).toBe(1)
  })

  test("first checks are spread over one interval", async () => {
    const { state, deployer } = harness([makeApp("tag")])
    ;(deployer as unknown as { deps: AutoDeployDeps }).deps.random = () => 0.5
    await deployer.tick()
    expect(state.lsCalls).toBe(0)
    state.now += INTERVAL / 2
    await deployer.tick()
    expect(state.lsCalls).toBe(1)
  })

  test("the token never reaches logs or stored errors", async () => {
    const token = "ghp_SECRET_TOKEN_123"
    const { state, deployer, app } = harness([
      makeApp("tag", { git: { repoUrl: "https://x.test/r.git", branch: "main", dockerfile: "Dockerfile", token, autoDeploy: "tag" } }),
    ])
    state.lsError = new Error("Authentication failed for repository — check the git token")
    await deployer.tick()
    expect(state.logs.join("\n")).not.toContain(token)
    expect(app().autoDeployError ?? "").not.toContain(token)
  })
})

describe("parseAutoDeployInterval", () => {
  test("defaults to 300 seconds", () => {
    expect(parseAutoDeployInterval(undefined)).toBe(300)
    expect(parseAutoDeployInterval("")).toBe(300)
  })

  test("reads strings (env) and numbers (config file)", () => {
    expect(parseAutoDeployInterval("600")).toBe(600)
    expect(parseAutoDeployInterval(600)).toBe(600)
  })

  test("raises values below 60 to 60", () => {
    expect(parseAutoDeployInterval("1")).toBe(60)
  })

  test.each(["0", "-5", "abc", "1.5", "5m", "1e3", " 600", "NaN", "Infinity", 0, -1, 1.5, Number.NaN, true, {}])(
    "rejects %p",
    (value) => {
      expect(() => parseAutoDeployInterval(value)).toThrow("SITEIO_AUTODEPLOY_INTERVAL")
    }
  )
})
