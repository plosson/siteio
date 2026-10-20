# Stop / start: keep app containers — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `apps stop` keeps the containers (so an image's anonymous volumes survive) and sets their restart policy to `no`. `apps start` starts the same containers and puts the policy back.

**Architecture:** This follows up the stop/start branch (`feat/stop-start`). Only the app stop and start paths change. Site stop/start, the deploy gates and the 404 host check stay as they are. Two `Runtime` methods are added: `start` and `setRestartPolicy`. The compose down that keeps volumes (`composeDownKeepVolumes`) is no longer used, so it is removed.

**Tech Stack:** Bun, TypeScript, `bun test` with `FakeRuntime`.

**Spec:** `docs/superpowers/specs/2026-10-20-stop-start-design.md` (updated: Model, Commands, "Allowed while stopped", Breaking changes, Tests)

## Global Constraints

- `apps stop` never removes a container and never runs `compose down`.
- Stop sets the restart policy to `no` on the app's container, or on every container of a compose project.
- Start puts the policy back:
  - single container: `app.restartPolicy`;
  - compose: each service's `restart:` from the resolved compose file, `"no"` when unset.
- Single-container start reuses the same container (`docker start`), and settings changed while stopped apply on the next deploy. If the container is gone, start recreates it (image on the server), and with no image either, it deploys. Both of these paths exist today, so keep them.
- Compose start runs `compose up` (`composeUpApp`), then restores the policies.
- Refused while stopped: unchanged. The message, 409, reason and gates stay as they are.
- Tests are adversarial: each one pins a way the feature could fail.

## Review Focus

1. **A stopped app comes back after a reboot.** The restart policy must be `no` on every container after stop. Tests assert `setRestartPolicy(…, "no")` for each container that `compose ps` lists.
2. **A started app no longer restarts after a reboot.** The policy must be put back. Tests use `restartPolicy: "always"` and compose `restart: always`.
3. **Stop deletes data.** Tests assert that `remove`, `composeDown` and `run` are never called on stop.
4. **Start recreates when it doesn't need to.** With the container present, tests assert `start` is called and `run` is not.
5. **An app stopped before this change.** Its container exists with its original policy. `start` must still work: setting the policy is idempotent.

---

### Task 1: Keep app containers on stop; start them again

**Files:**
- Modify: `src/lib/agent/runtime.ts`: add `start` and `setRestartPolicy`; remove `composeDownKeepVolumes`
- Modify: `src/lib/agent/docker.ts`: implement them; remove `composeDownKeepVolumes`
- Modify: `src/lib/agent/compose.ts`: remove `buildDownKeepVolumesArgs` and `downKeepVolumes`
- Modify: `src/__tests__/helpers/fake-runtime.ts`: record `start` and `setRestartPolicy`; remove `composeDownKeepVolumes`
- Modify: `src/lib/agent/server.ts`: `handleStopApp`, `startApp`
- Modify: `src/__tests__/unit/compose-manager.test.ts`: remove the `buildDownKeepVolumesArgs` test
- Test: `src/__tests__/api/apps-stop-start.test.ts`, `src/__tests__/api/apps-compose.test.ts`

**Interfaces:**
- Produces:
  - `Runtime.start(appName: string): Promise<void>`: runs `docker start siteio-<appName>`, the same naming as `restart`.
  - `Runtime.setRestartPolicy(container: string, policy: string): Promise<void>`: runs `docker update --restart <policy> <container>`. `container` is a container name or ID, used exactly as given.

- [ ] **Step 1: Write the failing tests**

In `src/__tests__/api/apps-stop-start.test.ts`, replace the whole `describe("apps stop", …)` block with:

```ts
describe("apps stop", () => {
  test("stops the container, keeps it, and turns its restart policy off", async () => {
    await deployedImageApp()
    const res = await call<App>("POST", "/apps/web/stop")
    expect(res.status).toBe(200)
    expect(res.body.data!.status).toBe("stopped")
    expect(runtime.callsOf("stop").map((c) => c.args[0])).toEqual(["web"])
    expect(runtime.callsOf("setRestartPolicy").map((c) => c.args)).toEqual([["siteio-web", "no"]])
    expect(runtime.callsOf("remove")).toHaveLength(0) // anonymous volumes stay attached
    expect(runtime.callsOf("run")).toHaveLength(0)
  })

  test("stopping twice is refused", async () => {
    await deployedImageApp()
    await call("POST", "/apps/web/stop")
    runtime.calls = []
    expect((await call("POST", "/apps/web/stop")).status).toBe(409)
    expect(runtime.callsOf("stop")).toHaveLength(0)
    expect(runtime.callsOf("setRestartPolicy")).toHaveLength(0)
  })
})
```

In the same file, add at the top of `describe("apps start", …)`:

```ts
  test("starts the same container and puts its restart policy back", async () => {
    expect((await call("POST", "/apps", { name: "web", image: "nginx:alpine", internalPort: 80, restartPolicy: "always" })).status).toBe(200)
    expect((await call("POST", "/apps/web/deploy")).status).toBe(200)
    runtime.containerExistsReturn = true
    runtime.imageExistsReturn = true
    await call("POST", "/apps/web/stop")
    runtime.calls = []

    const res = await call<App>("POST", "/apps/web/start")
    expect(res.status).toBe(200)
    expect(stored().status).toBe("running")
    expect(runtime.callsOf("setRestartPolicy").map((c) => c.args)).toEqual([["siteio-web", "always"]])
    expect(runtime.callsOf("start").map((c) => c.args[0])).toEqual(["web"])
    expect(runtime.callsOf("run")).toHaveLength(0)
    expect(runtime.callsOf("remove")).toHaveLength(0)
    expect(runtime.callsOf("pull")).toHaveLength(0)
  })

  test("settings changed while stopped wait for the next deploy", async () => {
    await deployedImageApp()
    await call("POST", "/apps/web/stop")
    await call("PATCH", "/apps/web", { env: { PLAN: "pro" } })
    runtime.calls = []
    expect((await call("POST", "/apps/web/start")).status).toBe(200)
    expect(runtime.callsOf("run")).toHaveLength(0) // same container, old settings
    runtime.calls = []
    expect((await call("POST", "/apps/web/deploy")).status).toBe(200)
    const run = runtime.callsOf("run")[0]!.args[0] as { env: Record<string, string> }
    expect(run.env.PLAN).toBe("pro")
  })

  test("a container stopped before the policy was turned off still starts", async () => {
    await deployedImageApp()
    new AppStorage(join(dir, "data")).update("web", { status: "stopped" }) // stopped by an older agent
    runtime.calls = []
    expect((await call("POST", "/apps/web/start")).status).toBe(200)
    expect(runtime.callsOf("start").map((c) => c.args[0])).toEqual(["web"])
    expect(stored().status).toBe("running")
  })

  test("a failing docker start marks the app failed", async () => {
    await deployedImageApp()
    await call("POST", "/apps/web/stop")
    runtime.startError = new Error("no such container")
    expect((await call("POST", "/apps/web/start")).status).toBe(500)
    expect(stored().status).toBe("failed")
  })
```

The existing tests "recreates the container from the image on the server…", "with the image gone, start falls back to a full deploy…", "a failed start marks the app failed" and "restart starts it, like start" set `runtime.containerExistsReturn = false` after stop, or rely on `runError`. Check each one:
- If it means "the container is gone", it must set `containerExistsReturn = false` before calling start. Add that line where it's missing.
- "a failed start marks the app failed" sets `runError`. Add `runtime.containerExistsReturn = false` before start, so it still exercises the recreate path.

In `src/__tests__/api/apps-compose.test.ts`, replace the test "stop removes the project's containers and keeps its volumes" with:

```ts
    test("stop stops the project, keeps its containers and turns every restart policy off", async () => {
      await setup("stopapp")
      runtime.composePsReturn = [
        { service: "web", containerId: "w1", state: "running" },
        { service: "db", containerId: "d1", state: "running" },
      ]
      const app = await jsonOk<App>(await req("POST", "/apps/stopapp/stop"))
      expect(app.status).toBe("stopped")
      expect(runtime.callsOf("composeStop")[0]!.args[0]).toBe("siteio-stopapp")
      expect(runtime.callsOf("setRestartPolicy").map((c) => c.args)).toEqual([["w1", "no"], ["d1", "no"]])
      expect(runtime.callsOf("composeDown")).toHaveLength(0) // that one passes -v
    })

    test("start brings the project up and puts each service's restart policy back", async () => {
      await setup("startapp")
      await req("POST", "/apps/startapp/stop")
      runtime.composeConfigReturn = { services: { web: { restart: "always" }, db: {} } }
      runtime.composePsReturn = [
        { service: "web", containerId: "w1", state: "running" },
        { service: "db", containerId: "d1", state: "running" },
      ]
      runtime.calls = []
      const app = await jsonOk<App>(await req("POST", "/apps/startapp/start"))
      expect(app.status).toBe("running")
      expect(runtime.callsOf("composeUp")).toHaveLength(1)
      expect(runtime.callsOf("setRestartPolicy").map((c) => c.args)).toEqual([["w1", "always"], ["d1", "no"]])
    })
```

In the "stop/restart/delete/logs thread siteio.env through" test, change the stop assertion back to:

```ts
      await req("POST", "/apps/lifecycleenv/stop")
      expect(runtime.callsOf("composeStop")[0]!.args[2]).toBe(expectedEnvPath)
```

In `src/__tests__/unit/compose-manager.test.ts`, delete the test "buildDownKeepVolumesArgs removes containers but never volumes".

- [ ] **Step 2: Run the tests and check that they fail**

Run: `bun test src/__tests__/api/apps-stop-start.test.ts src/__tests__/api/apps-compose.test.ts`
Expected: FAIL. Stop calls `remove` / `composeDownKeepVolumes`, `setRestartPolicy` and `start` are never called, and `runtime.startError` doesn't exist.

- [ ] **Step 3: Implement**

`runtime.ts`, next to `restart`:

```ts
  start(appName: string): Promise<void>
  // Name or ID, as given: compose containers are addressed by ID.
  setRestartPolicy(container: string, policy: string): Promise<void>
```

Remove `composeDownKeepVolumes` from the interface.

`docker.ts`, after `restart`. Same style as `restart`:

```ts
  /**
   * Start a stopped container
   */
  async start(appName: string): Promise<void> {
    const result = spawnSync({
      cmd: ["docker", "start", this.containerName(appName)],
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) {
      throw new SiteioError(`Failed to start container: ${result.stderr.toString()}`)
    }
  }

  /**
   * Change a container's restart policy in place (`docker update`)
   */
  async setRestartPolicy(container: string, policy: string): Promise<void> {
    const result = spawnSync({
      cmd: ["docker", "update", "--restart", policy, container],
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) {
      throw new SiteioError(`Failed to set restart policy: ${result.stderr.toString()}`)
    }
  }
```

Remove `composeDownKeepVolumes` from `docker.ts`, and `buildDownKeepVolumesArgs` / `downKeepVolumes` from `compose.ts`.

`fake-runtime.ts`: add a fixture `startError: Error | null = null` next to `runError`, and these methods next to `restart`:

```ts
  async start(appName: string): Promise<void> {
    this.record("start", [appName])
    if (this.startError) throw this.startError
  }

  async setRestartPolicy(container: string, policy: string): Promise<void> {
    this.record("setRestartPolicy", [container, policy])
  }
```

Remove `composeDownKeepVolumes`.

`server.ts`, in `handleStopApp`. Replace the `try` body up to the storage update:

```ts
    try {
      // Containers stay (their anonymous volumes with them); with the restart
      // policy off, a daemon or server restart can't bring them back.
      if (app.compose) {
        const files = this.composeFiles(app)
        const envFile = this.writeComposeEnvFile(app)
        await this.docker.composeStop(`siteio-${name}`, files, envFile)
        for (const s of await this.docker.composePs(`siteio-${name}`, files, envFile)) {
          await this.docker.setRestartPolicy(s.containerId, "no")
        }
      } else if (this.docker.containerExists(name)) {
        await this.docker.stop(name)
        await this.docker.setRestartPolicy(this.docker.containerName(name), "no")
      }
      const updated = this.appStorage.update(name, { status: "stopped" })!
```

The rest is unchanged. Keep `containerId`: the container still exists.

Update the comment above `handleStopApp`:

```ts
  // Take an app offline: stop its containers and turn their restart policy
  // off, so Traefik has no route and a reboot can't revive them. The
  // containers stay, so their anonymous volumes come back on `start`.
```

`startApp`. Replace the function:

```ts
  // Bring a stopped app back. Single container: the same container, with its
  // restart policy put back; settings changed while stopped apply on the next
  // deploy. Gone container: recreate it from the image on the server, or
  // deploy when that is gone too. Compose: `compose up` (unchanged containers
  // are reused), then each service's restart policy put back.
  private async startApp(app: App, by?: string): Promise<App> {
    if (!this.docker.isAvailable()) throw new DeployError("Docker is not available", 500)
    this.docker.ensureNetwork()
    const name = app.name
    const image = app.git || app.dockerfile ? this.docker.imageTag(name) : app.image
    const hasContainer = !app.compose && this.docker.containerExists(name)
    if (!app.compose && !hasContainer && !this.docker.imageExists(image)) return this.deployContainerApp(name, { deployedBy: by })
    try {
      let containerId = app.containerId
      if (app.compose) {
        containerId = (await this.composeUpApp(app)).containerId
        const { spec } = await this.resolveComposeBase(app)
        const project = `siteio-${name}`
        const files = this.composeFiles(app)
        for (const s of await this.docker.composePs(project, files, this.writeComposeEnvFile(app))) {
          const restart = (spec.services[s.service] as { restart?: string } | undefined)?.restart ?? "no"
          await this.docker.setRestartPolicy(s.containerId, restart)
        }
      } else if (hasContainer) {
        await this.docker.setRestartPolicy(this.docker.containerName(name), app.restartPolicy)
        await this.docker.start(name)
      } else {
        containerId = await this.runAppContainer(app, await this.tenantSafeImage(name, image))
      }
      const updated = this.appStorage.update(name, { status: "running", containerId })
      if (!updated) throw new DeployError("App not found", 404)
      this.pageApp(updated, "started", by)
      return updated
    } catch (err) {
      this.appStorage.update(name, { status: "failed" })
      if (err instanceof DeployError) throw err
      throw new DeployError(err instanceof Error ? err.message : "Failed to start app", 500)
    }
  }
```

`resolveComposeBase` may throw `ValidationError`. It runs after `composeUpApp`, which already resolved the same file, so a failure there is unexpected. The `catch` turns it into a 500 and marks the app `failed`. That's acceptable.

If `resolveComposeBase` returns its spec under a different property name than `{ spec }`, check its signature in `server.ts` and use that name.

- [ ] **Step 4: Run all the tests and check that they pass**

Run: `bun test && bun run typecheck`
Expected: PASS. Run `grep -rn "DownKeepVolumes" src` and expect no output.

- [ ] **Step 5: Commit**

```bash
git add -A src
git commit -m "fix(apps): stop keeps the containers (anonymous volumes survive) and turns their restart policy off; start puts it back"
```

---

### Task 2: Docs

**Files:**
- Modify: `src/lib/skill-content.ts` (the apps "**Lifecycle**" line)
- Modify: `CLAUDE.md` (the "**Stop / start**" bullet)
- Modify: `docs/superpowers/plans/2026-10-20-stop-start.md` (Task 8 release notes)

- [ ] **Step 1: Write the docs**

`skill-content.ts`. Replace the whole Lifecycle line with:

```
- **Lifecycle**: \`siteio apps stop|start|restart|rm myapp\`. \`stop\` stops the containers (they and their volumes are kept) and the URL answers 404, even after a reboot; \`start\` (or \`restart\`) brings back the same containers. Settings changed with \`apps set\` while stopped apply on the next \`apps deploy\`. A stopped app refuses \`deploy\`: start it first
```

`CLAUDE.md`. Replace the Stop / start bullet with:

```
- **Stop / start**: `siteio sites stop|start`, `siteio apps stop|start|restart` take a site or app offline (404, data kept; site containers removed, app containers stopped with their restart policy off) and bring it back as it was; a stopped item refuses deploys until started
```

`docs/superpowers/plans/2026-10-20-stop-start.md`, Task 8. Replace the release-notes bullets with:

```
  - `apps deploy` on a stopped app now fails; use `apps start` (or `apps restart`) first.
  - `apps stop` now also turns the containers' restart policy off until `apps start`, so a stopped app stays stopped after a reboot. Containers and volumes are kept.
  - Apps already stopped on servers are affected by the first point.
```

- [ ] **Step 2: Check and commit**

Run: `bun test && bun run typecheck`
Expected: PASS.

```bash
git add src/lib/skill-content.ts CLAUDE.md docs/superpowers/plans/2026-10-20-stop-start.md
git commit -m "docs: app stop keeps the containers"
```
