import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { spawn, spawnSync } from "bun"

// Site card previews are produced by a headless-Chromium container
// (browserless) rather than bundling a browser into the CLI. The container is
// started on demand — the first capture pulls the pinned image and boots it,
// and an idle timer tears it down again — so it costs nothing when no
// thumbnails are being taken. Captures hit the site's INTERNAL address on
// siteio-network (http://siteio-<name>:8090), avoiding TLS/cert timing and any
// public round-trip. Every operation is best-effort: a failure just leaves the
// card showing its placeholder, it never breaks a deploy.
const CONTAINER_NAME = "siteio-browserless"
const IMAGE = "ghcr.io/browserless/chromium:v2.55.4"
// Published on loopback only — the agent runs on the host, the container on the
// docker network, so it reaches back over this port while itself resolving
// site containers by name over siteio-network.
const HOST_PORT = 9333
const NETWORK = "siteio-network"
const IDLE_STOP_MS = 3 * 60 * 1000
const READY_TIMEOUT_MS = 20_000
const GOTO_TIMEOUT_MS = 10_000
const CAPTURE_TIMEOUT_MS = 20_000
const VIEWPORT = { width: 1280, height: 800 }

export interface CaptureResult {
  ok: boolean
  // Human-readable failure reason when ok is false (surfaced to the UI).
  reason?: string
}

export class ThumbnailManager {
  private thumbsDir: string
  private token: string
  private endpoint: string
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  // Guards against two concurrent captures both trying to boot the container.
  private ensuring: Promise<boolean> | null = null
  // Guards the (slow, ~3GB) image pull so it runs at most once at a time and is
  // shared between a startup pre-warm and any concurrent capture request.
  private pulling: Promise<boolean> | null = null

  constructor(dataDir: string) {
    this.thumbsDir = join(dataDir, "thumbnails")
    if (!existsSync(this.thumbsDir)) mkdirSync(this.thumbsDir, { recursive: true, mode: 0o755 })
    this.token = this.loadOrCreateToken()
    this.endpoint = `http://127.0.0.1:${HOST_PORT}`
  }

  private thumbPath(name: string): string {
    return join(this.thumbsDir, `${name}.webp`)
  }

  has(name: string): boolean {
    return existsSync(this.thumbPath(name))
  }

  read(name: string): Uint8Array | null {
    return this.has(name) ? readFileSync(this.thumbPath(name)) : null
  }

  delete(name: string): void {
    const p = this.thumbPath(name)
    if (existsSync(p)) rmSync(p)
  }

  // Capture a preview of the given URL and store it as <name>.webp. Best-effort:
  // never throws — reports the reason so callers (e.g. the manual-refresh
  // endpoint) can surface it to the user instead of a generic failure.
  async capture(name: string, url: string): Promise<CaptureResult> {
    try {
      if (!(await this.ensureBrowserless())) {
        return this.fail(name, "preview browser is not available (Docker or image issue — see agent logs)")
      }
      const bytes = await this.screenshot(url)
      writeFileSync(this.thumbPath(name), bytes, { mode: 0o644 })
      this.scheduleIdleStop()
      return { ok: true }
    } catch (err) {
      return this.fail(name, this.msg(err))
    }
  }

  private fail(name: string, reason: string): CaptureResult {
    console.log(`> Thumbnail capture failed for '${name}': ${reason}`)
    return { ok: false, reason }
  }

  // Download the browserless image ahead of time (background, non-blocking) so
  // the first capture doesn't pay a multi-minute pull inside a request — which,
  // behind a CDN with a request timeout, would never complete in time. Safe to
  // call on every agent start: it's a no-op once the image is cached.
  prewarm(): void {
    void this.ensureImage()
  }

  // Tear down the browserless container (also invoked by the idle timer).
  stop(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    if (this.containerExists()) {
      spawnSync({ cmd: ["docker", "rm", "-f", CONTAINER_NAME], stdout: "pipe", stderr: "pipe" })
    }
  }

  // --- browserless lifecycle ---

  private async ensureBrowserless(): Promise<boolean> {
    if (this.isRunning()) return true
    if (this.ensuring) return this.ensuring
    this.ensuring = this.startBrowserless().finally(() => {
      this.ensuring = null
    })
    return this.ensuring
  }

  private async startBrowserless(): Promise<boolean> {
    if (!this.dockerAvailable()) return false
    if (!(await this.ensureImage())) return false

    // A stopped container from a previous run holds the name — remove it first.
    if (this.containerExists()) {
      spawnSync({ cmd: ["docker", "rm", "-f", CONTAINER_NAME], stdout: "pipe", stderr: "pipe" })
    }
    this.ensureNetwork()

    const run = spawnSync({
      cmd: [
        "docker", "run", "-d",
        "--name", CONTAINER_NAME,
        "--network", NETWORK,
        // Not managed by systemd — the idle timer owns its lifecycle.
        "--restart", "no",
        // Full Chromium spikes during rasterization on heavy pages (measured
        // peak ~670MB on a 217KB DOM); 512m OOM-killed the raster child and
        // surfaced as a ProtocolError. The container is on-demand + idle-stops,
        // so this ceiling is only used transiently during a capture.
        "--memory", "1500m",
        "-p", `127.0.0.1:${HOST_PORT}:3000`,
        "-e", `TOKEN=${this.token}`,
        "-e", "CONCURRENT=1",
        // Queue bursts (deploy storms, a page of cards) instead of 429-ing.
        "-e", "QUEUED=8",
        "-e", "TIMEOUT=15000",
        IMAGE,
      ],
      stdout: "pipe",
      stderr: "pipe",
    })
    if (run.exitCode !== 0) {
      console.log(`> Failed to start browserless: ${run.stderr.toString().slice(0, 200)}`)
      return false
    }
    return this.waitUntilReady()
  }

  // Ensure the image is present, pulling it asynchronously if not. The pull runs
  // via Bun.spawn (NOT spawnSync) so the ~3GB download never blocks the agent's
  // event loop, and concurrent callers share the one in-flight pull.
  private async ensureImage(): Promise<boolean> {
    if (this.imageExists()) return true
    if (!this.dockerAvailable()) return false
    if (this.pulling) return this.pulling
    this.pulling = this.pullImage().finally(() => {
      this.pulling = null
    })
    return this.pulling
  }

  private async pullImage(): Promise<boolean> {
    console.log(`> Pulling ${IMAGE} for site previews (one-time, ~3GB)...`)
    try {
      const proc = spawn({ cmd: ["docker", "pull", IMAGE], stdout: "ignore", stderr: "pipe" })
      const code = await proc.exited
      if (code !== 0) {
        const err = await new Response(proc.stderr).text()
        console.log(`> Could not pull ${IMAGE}: ${err.slice(0, 200)}`)
        return false
      }
      console.log(`> ${IMAGE} ready for site previews`)
      return true
    } catch (err) {
      console.log(`> Could not pull ${IMAGE}: ${this.msg(err)}`)
      return false
    }
  }

  private async waitUntilReady(): Promise<boolean> {
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      try {
        // Any HTTP response means the port is accepting connections.
        await fetch(`${this.endpoint}/`, { method: "GET" })
        return true
      } catch {
        // Not up yet.
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    console.log("> browserless did not become ready in time")
    return false
  }

  private async screenshot(url: string): Promise<Uint8Array> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), CAPTURE_TIMEOUT_MS)
    try {
      const res = await fetch(`${this.endpoint}/screenshot?token=${this.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          url,
          options: { type: "webp", quality: 80, fullPage: false },
          viewport: VIEWPORT,
          // "load" (not networkidle): sites with fonts/analytics/long-polling
          // never go network-idle, and browserless would 500 on the timeout.
          // bestAttempt returns whatever rendered if navigation times out.
          gotoOptions: { waitUntil: "load", timeout: GOTO_TIMEOUT_MS },
          bestAttempt: true,
        }),
      })
      if (!res.ok) {
        const body = (await res.text()).slice(0, 200)
        if (res.status === 429) {
          throw new Error("preview browser is busy (too many captures at once) — try again in a moment")
        }
        throw new Error(`preview browser error ${res.status}${body ? `: ${body}` : ""}`)
      }
      return new Uint8Array(await res.arrayBuffer())
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`capture timed out after ${Math.round(CAPTURE_TIMEOUT_MS / 1000)}s`)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  private scheduleIdleStop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.stop(), IDLE_STOP_MS)
    // Don't keep the process alive just for the teardown timer.
    this.idleTimer.unref?.()
  }

  // --- token persistence ---

  // The token must survive agent restarts: otherwise a browserless container
  // left running from before would reject the new token. Persist it alongside
  // the thumbnails so the running container and the agent always agree.
  private loadOrCreateToken(): string {
    const p = join(this.thumbsDir, ".token")
    try {
      if (existsSync(p)) {
        const t = readFileSync(p, "utf-8").trim()
        if (t) return t
      }
    } catch {
      // Fall through to regenerate.
    }
    const token = crypto.randomUUID().replace(/-/g, "")
    try {
      writeFileSync(p, token, { mode: 0o600 })
    } catch {
      // Non-fatal: an in-memory token still works for this process's lifetime.
    }
    return token
  }

  // --- docker helpers (self-contained, mirroring TraefikManager) ---

  private dockerAvailable(): boolean {
    const r = spawnSync({ cmd: ["docker", "info"], stdout: "pipe", stderr: "pipe" })
    return r.exitCode === 0
  }

  private isRunning(): boolean {
    const r = spawnSync({
      cmd: ["docker", "inspect", "-f", "{{.State.Running}}", CONTAINER_NAME],
      stdout: "pipe",
      stderr: "pipe",
    })
    return r.exitCode === 0 && r.stdout.toString().trim() === "true"
  }

  private containerExists(): boolean {
    const r = spawnSync({ cmd: ["docker", "inspect", CONTAINER_NAME], stdout: "pipe", stderr: "pipe" })
    return r.exitCode === 0
  }

  private imageExists(): boolean {
    const r = spawnSync({ cmd: ["docker", "image", "inspect", IMAGE], stdout: "pipe", stderr: "pipe" })
    return r.exitCode === 0
  }

  private ensureNetwork(): void {
    const inspect = spawnSync({
      cmd: ["docker", "network", "inspect", NETWORK],
      stdout: "pipe",
      stderr: "pipe",
    })
    if (inspect.exitCode !== 0) {
      spawnSync({ cmd: ["docker", "network", "create", NETWORK], stdout: "pipe", stderr: "pipe" })
    }
  }

  private msg(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
  }
}
