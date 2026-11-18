import { existsSync, realpathSync } from "fs"
import { dirname, isAbsolute, join, resolve, sep } from "path"
import type { AgentConfig, App, AppInfo, AppServiceStatus, AppStatus, ContainerLogs } from "../../types.ts"
import { ValidationError } from "../../utils/errors.ts"
import type { AppStorage } from "./app-storage.ts"
import { AUTO_DEPLOY_MODES, isAutoDeployMode } from "./auto-deploy.ts"
import { type ComposeSpec, composeWarnings, missingPrimaryService } from "./compose.ts"
import { buildOverride } from "./compose-override.ts"
import type { ComposeStorage } from "./compose-storage.ts"
import type { DockerfileStorage } from "./dockerfile-storage.ts"
import type { GitManager } from "./git.ts"
import type { Pager, Ranking } from "./hooks.ts"
import {
  ENV_KEY_RE,
  scrubApp,
  TENANT_DENIED_ENV,
  TENANT_DENIED_ENV_PREFIXES,
  VOLUME_NAME_RE,
} from "./request-shaping.ts"
import type { Runtime } from "./runtime.ts"
import { DeployError } from "./server.ts"
import { assertValidNewName, type Caller, normalizeDomains, type Scope, type TenantRegistry } from "./tenants.ts"
import type { ThumbnailManager } from "./thumbnails.ts"
import type { TraefikManager } from "./traefik.ts"

// Everything the app routes need from the agent server that owns them: its
// collaborators (storages, runtime, registries, hooks) and the request/response
// helpers shared with the rest of the surface. AgentServer satisfies this
// structurally.
export interface AppRouteContext {
  config: AgentConfig
  appStorage: AppStorage
  docker: Runtime
  git: GitManager
  compose: ComposeStorage
  dockerfiles: DockerfileStorage
  tenants: TenantRegistry
  thumbnails: ThumbnailManager | null
  traefik: TraefikManager | null
  pager: Pager | null
  ranking: Ranking | null
  error(message: string, status?: number, reason?: string): Response
  json<T>(data: T, status?: number): Response
  requestUser(req: Request): string | undefined
  customDomainsViolation(kind: "site" | "app", key: string, domains: string[], caller: Caller): string | null
  stoppedMessage(kind: "site" | "app", key: string, scope: Scope): string
  stoppedError(kind: "site" | "app", key: string, scope: Scope): Response
  isDeploying(name: string): boolean
  addDeploying(name: string): void
  deleteDeploying(name: string): void
  captureThumbnail(name: string, url: string): void
}

// Docker container apps (/apps): create/update/delete, deploy (image, git or
// compose), stop/start/restart, status/logs, thumbnails and pager reporting.
export class AppRoutes {
  constructor(private ctx: AppRouteContext) {}

  // An app as `scope` sees it: secrets scrubbed, a tenant's key as its bare name.
  private appView(app: App, scope: Scope): App {
    return { ...scrubApp(app), name: this.ctx.tenants.displayName(app.name, scope) }
  }

  // Why a tenant may not put `fields` in its app, or null. A compose stack can
  // mount the host and pick its networks; a volume path reaches the host's
  // files; a build context or Dockerfile outside the clone reads the agent's
  // data. The operator (god key or admin user) is not restricted.
  private tenantAppViolation(
    caller: Caller,
    fields: {
      compose?: boolean
      volumes?: { name: string }[]
      git?: { repoUrl?: string; context?: string; dockerfile?: string }
      env?: Record<string, string>
      secrets?: Record<string, string>
    },
  ): string | null {
    if (caller.admin) return null
    if (fields.compose) return "Compose apps are not available to a tenant"
    // Any other scheme or a bare path clones from the agent's own disk or
    // network (file://, ssh with the agent's keys)
    if (
      fields.git?.repoUrl !== undefined &&
      (typeof fields.git.repoUrl !== "string" || !fields.git.repoUrl.startsWith("https://"))
    ) {
      return "git.repoUrl must be an https:// URL"
    }
    for (const field of ["env", "secrets"] as const) {
      for (const key of Object.keys(fields[field] ?? {})) {
        const upper = key.toUpperCase()
        if (
          !ENV_KEY_RE.test(key) ||
          TENANT_DENIED_ENV.includes(upper) ||
          TENANT_DENIED_ENV_PREFIXES.some((p) => upper.startsWith(p))
        ) {
          return `${field === "env" ? "Env" : "Secret"} key '${key}' is not allowed for a tenant app`
        }
      }
    }
    for (const field of ["context", "dockerfile"] as const) {
      const path = fields.git?.[field]
      if (path === undefined) continue
      if (typeof path !== "string" || isAbsolute(path) || path.split("/").includes("..")) {
        return `git.${field} must be a relative path inside the repository`
      }
    }
    const volumes: unknown = fields.volumes ?? []
    const isMount = (v: unknown) =>
      typeof v === "object" &&
      v !== null &&
      typeof (v as { name?: unknown }).name === "string" &&
      typeof (v as { mountPath?: unknown }).mountPath === "string"
    if (!Array.isArray(volumes) || !volumes.every(isMount)) {
      return "'volumes' must be a list of { name, mountPath }"
    }
    for (const volume of volumes as { name: string }[]) {
      if (!VOLUME_NAME_RE.test(volume.name)) {
        return `Volume '${volume.name}' must be a plain name (letters, digits, '.', '_', '-'), not a path`
      }
    }
    return null
  }

  async handleListApps(caller: Caller): Promise<Response> {
    const apps = this.ctx.appStorage.list().filter((app) => this.ctx.tenants.sees(app.name, caller))

    // Get TLS status from Traefik if available
    const tlsStatusMap = this.ctx.traefik ? await this.ctx.traefik.getAllRoutersTlsStatus() : new Map()

    const appInfos: AppInfo[] = apps.map((app) =>
      scrubApp({
        ...this.ctx.appStorage.toInfo(app, this.ctx.tenants, caller.scope),
        tls: tlsStatusMap.get(`siteio-${app.name}`) || "pending",
        hasThumbnail: this.ctx.thumbnails?.has(app.name) ?? false,
      }),
    )
    return this.ctx.json(appInfos)
  }

  handleGetApp(name: string, scope: Scope): Response {
    const app = this.ctx.appStorage.get(name)
    if (!app) {
      return this.ctx.error("App not found", 404)
    }
    return this.ctx.json(this.appView(app, scope))
  }

  async handleCreateApp(req: Request, caller: Caller): Promise<Response> {
    const scope = caller.scope
    try {
      const body = (await req.json()) as {
        name: string
        type?: string
        image?: string
        git?: {
          repoUrl: string
          branch?: string
          dockerfile?: string
          context?: string
          token?: string
          autoDeploy?: unknown
        }
        dockerfileContent?: string
        composeContent?: string
        composePath?: string
        envFileContent?: string
        primaryService?: string
        internalPort?: number
        domains?: string[]
        env?: Record<string, string>
        secrets?: Record<string, string>
        volumes?: Array<{ name: string; mountPath: string }>
        restartPolicy?: string
      }

      if (!body.name) {
        return this.ctx.error("App name is required")
      }

      // The key the app is stored, built, run and routed under. keyFor checks
      // a tenant's bare name; a primary name is checked here.
      const name = this.ctx.tenants.keyFor(body.name, scope)
      if (!scope) assertValidNewName(name, "App")
      if (this.ctx.appStorage.exists(name)) return this.ctx.error(`App '${body.name}' already exists`)

      const domains = body.domains === undefined ? [] : normalizeDomains(body.domains)
      const domainViolation = this.ctx.customDomainsViolation("app", name, domains, caller)
      if (domainViolation) return this.ctx.error(domainViolation)

      const hasCompose = !!body.composeContent || !!body.composePath
      const hasGit = !!body.git
      const hasImage = !!body.image
      const hasInlineDockerfile = !!body.dockerfileContent

      const violation = this.tenantAppViolation(caller, {
        compose: hasCompose,
        volumes: body.volumes,
        git: body.git,
        env: body.env,
        secrets: body.secrets,
      })
      if (violation) return this.ctx.error(violation)

      // Mutual exclusivity: image / inline-dockerfile / compose / git.
      // git may coexist with composePath OR GitSource.dockerfile, not both.
      const primarySources = [hasImage, hasInlineDockerfile, hasCompose, hasGit].filter(Boolean).length
      if (primarySources === 0) {
        return this.ctx.error("Either image, git source, dockerfile, or compose is required")
      }
      if (hasImage && (hasInlineDockerfile || hasCompose || hasGit)) {
        return this.ctx.error("--image cannot be combined with other source flags")
      }
      if (hasInlineDockerfile && (hasCompose || hasGit)) {
        return this.ctx.error("--file cannot be combined with git or compose sources")
      }
      if (body.composeContent && body.composePath) {
        return this.ctx.error("Specify either composeContent (inline) or composePath (git), not both")
      }
      if (body.composePath && !hasGit) {
        return this.ctx.error("composePath requires --git")
      }
      if (hasCompose && !body.primaryService) {
        return this.ctx.error("primaryService is required when using a compose file")
      }
      if (!hasCompose && body.primaryService) {
        return this.ctx.error("primaryService is only valid with a compose source")
      }
      if (body.envFileContent && !hasCompose) {
        return this.ctx.error("envFileContent is only valid when a compose file is provided")
      }

      if (body.git && !body.git.repoUrl) {
        return this.ctx.error("Git repository URL is required")
      }
      if (body.git?.autoDeploy !== undefined) {
        if (!isAutoDeployMode(body.git.autoDeploy)) {
          return this.ctx.error(`autoDeploy must be one of: ${AUTO_DEPLOY_MODES.join(", ")}`)
        }
        if (hasCompose) {
          return this.ctx.error("autoDeploy is only supported on single-container git apps")
        }
      }

      // Determine image tag for locally-built or compose-tagged apps.
      const image = hasGit || hasInlineDockerfile || hasCompose ? this.ctx.docker.imageTag(name) : body.image!

      // Persist inline Dockerfile / compose file up-front; roll back on create failure.
      if (body.dockerfileContent) {
        this.ctx.dockerfiles.write(name, body.dockerfileContent)
      }
      if (body.composeContent) {
        this.ctx.compose.writeBaseInline(name, body.composeContent)
      }
      if (body.envFileContent) {
        this.ctx.compose.writeBaseEnv(name, body.envFileContent)
      }

      try {
        const composeField: App["compose"] = hasCompose
          ? body.composeContent
            ? { source: "inline", primaryService: body.primaryService! }
            : { source: "git", path: body.composePath!, primaryService: body.primaryService! }
          : undefined
        // Uploaded files are checked now; a git repo is only cloned at deploy
        const warnings =
          composeField?.source === "inline"
            ? await this.checkUploadedCompose({ name, domains: domains, compose: composeField })
            : undefined

        const app = this.ctx.appStorage.create({
          name,
          type: "container",
          image,
          git: body.git
            ? {
                repoUrl: body.git.repoUrl,
                branch: body.git.branch || "main",
                dockerfile: body.git.dockerfile || "Dockerfile",
                context: body.git.context,
                token: body.git.token,
                ...(isAutoDeployMode(body.git.autoDeploy) && { autoDeploy: body.git.autoDeploy }),
              }
            : undefined,
          dockerfile: body.dockerfileContent ? { source: "inline" } : undefined,
          compose: composeField,
          internalPort: body.internalPort || 80,
          domains: domains,
          env: { ...body.env, ...body.secrets },
          ...(body.secrets && Object.keys(body.secrets).length > 0 && { secretKeys: Object.keys(body.secrets) }),
          volumes: body.volumes || [],
          restartPolicy: (body.restartPolicy as "always" | "unless-stopped" | "on-failure" | "no") || "unless-stopped",
          status: "pending",
        })

        return this.ctx.json({ ...this.appView(app, scope), ...(warnings && { warnings }) })
      } catch (err) {
        if (body.dockerfileContent) this.ctx.dockerfiles.remove(name)
        if (body.composeContent) this.ctx.compose.remove(name)
        throw err
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create app"
      return this.ctx.error(message, 400)
    }
  }

  async handleUpdateApp(name: string, req: Request, caller: Caller): Promise<Response> {
    const scope = caller.scope
    try {
      const app = this.ctx.appStorage.get(name)
      if (!app) {
        return this.ctx.error("App not found", 404)
      }

      // `compose` is server-owned: clients change it through primaryService only
      const {
        composeContent,
        envFileContent,
        primaryService,
        compose: _ignored,
        autoDeployRef: _ref,
        autoDeployCheckedAt: _checkedAt,
        autoDeployError: _error,
        ...body
      } = (await req.json()) as Partial<Omit<App, "name" | "createdAt">> & {
        secrets?: Record<string, string>
        composeContent?: string
        envFileContent?: string
        primaryService?: string
      }

      if (body.domains !== undefined) {
        body.domains = normalizeDomains(body.domains)
        const domainViolation = this.ctx.customDomainsViolation("app", name, body.domains, caller)
        if (domainViolation) return this.ctx.error(domainViolation)
      }

      const violation = this.tenantAppViolation(caller, {
        volumes: body.volumes,
        git: body.git,
        env: body.env,
        secrets: body.secrets,
      })
      if (violation) return this.ctx.error(violation)

      // Compose sources: same fields as create, replaced in place so a stack
      // can change without removing the app (and its volumes).
      const filesChange = composeContent !== undefined || envFileContent !== undefined
      if (filesChange || primaryService !== undefined) {
        if (!app.compose) {
          return this.ctx.error("composeContent, envFileContent and primaryService are only valid on compose apps")
        }
        if (composeContent !== undefined && app.compose.source !== "inline") {
          return this.ctx.error(
            "This app's compose file comes from its git repository: push the change there and redeploy",
          )
        }
        if (composeContent !== undefined && !composeContent.trim()) {
          return this.ctx.error("composeContent cannot be empty")
        }
        if (primaryService !== undefined && !primaryService.trim()) {
          return this.ctx.error("primaryService cannot be empty")
        }
      }

      // Auto-deploy only runs single-container git apps. A new mode, repository
      // or branch starts from a clean poller state.
      const incomingGit = body.git as { autoDeploy?: unknown; repoUrl?: unknown; branch?: unknown } | undefined
      const autoDeploy = incomingGit?.autoDeploy
      if (autoDeploy !== undefined) {
        if (!isAutoDeployMode(autoDeploy)) {
          return this.ctx.error(`autoDeploy must be one of: ${AUTO_DEPLOY_MODES.join(", ")}`)
        }
        if (!app.git || app.compose) {
          return this.ctx.error("autoDeploy is only supported on single-container git apps")
        }
      }
      const changed = (incoming: unknown, current: unknown) => incoming !== undefined && incoming !== current
      const autoDeployReset =
        changed(autoDeploy, app.git?.autoDeploy ?? "off") ||
        changed(incomingGit?.repoUrl, app.git?.repoUrl) ||
        changed(incomingGit?.branch, app.git?.branch)
          ? { autoDeployRef: undefined, autoDeployError: undefined }
          : {}

      // Field-level merge for git so partial updates (e.g. only --git-token or
      // only --dockerfile) preserve other stored fields. Also strip clients'
      // incoming `tokenSet` — it's an output-only hint.
      if (body.git && app.git) {
        const { tokenSet: _drop, ...incoming } = body.git as typeof body.git & { tokenSet?: boolean }
        body.git = { ...app.git, ...incoming }
      }

      // Write the new files, then check them and update the record; put the
      // previous files back if either step rejects the request.
      const compose = app.compose && primaryService !== undefined ? { ...app.compose, primaryService } : app.compose
      const previous = filesChange ? this.ctx.compose.snapshot(name) : undefined
      if (composeContent !== undefined) this.ctx.compose.writeBaseInline(name, composeContent)
      if (envFileContent !== undefined) this.ctx.compose.writeBaseEnv(name, envFileContent)

      let updated: App | null
      let warnings: string[] | undefined
      try {
        if (compose?.source === "inline" && (filesChange || primaryService !== undefined)) {
          // Checked against the domains this same request may set
          warnings = await this.checkUploadedCompose({ name, domains: body.domains ?? app.domains, compose })
        }
        updated = this.ctx.appStorage.update(name, {
          ...body,
          ...autoDeployReset,
          ...(compose !== app.compose && { compose }),
        })
      } catch (err) {
        if (previous) this.ctx.compose.restore(name, previous)
        throw err
      }
      if (!updated) {
        return this.ctx.error("Failed to update app", 500)
      }

      return this.ctx.json({ ...this.appView(updated, scope), ...(warnings && { warnings }) })
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update app"
      return this.ctx.error(message, 400)
    }
  }

  async handleDeleteApp(name: string): Promise<Response> {
    const app = this.ctx.appStorage.get(name)
    if (!app) {
      return this.ctx.error("App not found", 404)
    }
    if (this.ctx.isDeploying(name)) {
      return this.ctx.error("Deploy already in progress", 409)
    }

    if (app.compose) {
      try {
        const files = this.composeFiles(app)
        await this.ctx.docker.composeDown(`siteio-${name}`, files, this.writeComposeEnvFile(app))
      } catch {
        // Best-effort; the base file may be missing if the repo was cleaned up.
      }
      try {
        this.ctx.compose.remove(name)
      } catch {
        // Ignore
      }
    } else {
      if (this.ctx.docker.containerExists(name)) {
        try {
          await this.ctx.docker.remove(name)
        } catch {
          // Ignore
        }
      }
      if (app.dockerfile && this.ctx.dockerfiles.exists(name)) {
        try {
          this.ctx.dockerfiles.remove(name)
        } catch {
          // Ignore
        }
      }
      if (app.git || app.dockerfile) {
        try {
          const imageTag = this.ctx.docker.imageTag(name)
          await this.ctx.docker.removeImage(imageTag)
        } catch {
          // Ignore
        }
      }
    }

    if (app.git && this.ctx.git.exists(name)) {
      try {
        await this.ctx.git.remove(name)
      } catch {
        // Ignore
      }
    }

    const deleted = this.ctx.appStorage.delete(name)
    if (!deleted) {
      return this.ctx.error("Failed to delete app", 500)
    }
    this.ctx.thumbnails?.delete(name)
    return this.ctx.json(null)
  }

  async handleDeployApp(name: string, url: URL, req: Request, scope: Scope): Promise<Response> {
    const app = this.ctx.appStorage.get(name)
    if (!app) {
      return this.ctx.error("App not found", 404)
    }
    if (app.status === "stopped") return this.ctx.stoppedError("app", name, scope)

    const noCache = url.searchParams.get("noCache") === "true"

    // Optional JSON body lets the client push a fresh Dockerfile at deploy time
    // (for inline-dockerfile apps only). The body is optional — bare POSTs still work.
    let newDockerfileContent: string | undefined
    const contentType = req.headers.get("Content-Type") || ""
    if (contentType.includes("application/json")) {
      try {
        const body = (await req.json()) as { dockerfileContent?: string }
        newDockerfileContent = body.dockerfileContent
      } catch {
        // Empty or malformed body — ignore, treat as bare deploy
      }
    }

    if (newDockerfileContent && !app.dockerfile) {
      return this.ctx.error("Cannot override Dockerfile: app was not created with -f", 400)
    }

    const deployedBy = this.ctx.requestUser(req)
    try {
      if (app.compose) {
        const { updated, warnings } = await this.deployComposeApp(app, deployedBy)
        return this.ctx.json({
          ...this.appView(updated, scope),
          url: this.ctx.appStorage.url(updated, this.ctx.tenants),
          warnings,
        })
      }
      const updated = await this.deployContainerApp(name, {
        noCache,
        dockerfileContent: newDockerfileContent,
        deployedBy,
      })
      return this.ctx.json({ ...this.appView(updated, scope), url: this.ctx.appStorage.url(updated, this.ctx.tenants) })
    } catch (err) {
      const status = err instanceof DeployError ? err.status : 500
      return this.ctx.error(err instanceof Error ? err.message : "Failed to deploy app", status)
    }
  }

  /**
   * Write the siteio override for the app's current config and bring the
   * project up. Returns the primary service's container ID. Throws DeployError.
   */
  private async composeUpApp(app: App): Promise<{ containerId?: string; warnings: string[] }> {
    const { name, compose } = app
    if (!compose) throw new DeployError("Not a compose app", 400)
    const project = `siteio-${name}`

    // Resolve the base file alone: it must hold the primary service, and
    // the override needs the networks that service is already on.
    let resolved: { spec: ComposeSpec; warnings: string[] }
    try {
      resolved = await this.resolveComposeBase(app)
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err
      throw new DeployError(err.message, 400)
    }
    const primary = resolved.spec.services[compose.primaryService] as { networks?: Record<string, unknown> }

    // Regenerate the override every time so env/domain updates apply
    const overrideYaml = buildOverride(app, {
      domains: this.ctx.appStorage.routedDomains(app, this.ctx.tenants),
      baseNetworks: Object.keys(primary.networks ?? {}),
      dataDir: this.ctx.config.dataDir,
    })
    this.ctx.compose.writeOverride(name, overrideYaml)
    const files = [this.composeBasePath(app), this.ctx.compose.overridePath(name)]
    const envFile = this.writeComposeEnvFile(app)

    await this.ctx.docker.composeUp(project, files, envFile)
    const ps = await this.ctx.docker.composePs(project, files, envFile)
    const containerId = ps.find((s) => s.service === compose.primaryService)?.containerId
    return { containerId, warnings: resolved.warnings }
  }

  // Traefik reads the labels baked into an image too: a tenant's image could
  // route any hostname, the operator's API included, to itself. Tenant
  // containers run from the inspected ID, so a concurrent retag can't swap it.
  private async tenantSafeImage(name: string, image: string): Promise<string> {
    if (!this.ctx.tenants.ownerOf(name)) return image
    const { id, labels } = await this.ctx.docker.imageInspect(image)
    if (Object.keys(labels).some((key) => key.toLowerCase().startsWith("traefik."))) {
      throw new DeployError("Image labels starting with 'traefik.' are not allowed for tenant apps", 400)
    }
    return id
  }

  // Replace the app's container with one running `image`, routed on its
  // domains. Returns the new container ID.
  private async runAppContainer(app: App, image: string): Promise<string> {
    if (this.ctx.docker.containerExists(app.name)) await this.ctx.docker.remove(app.name)
    const labels = this.ctx.docker.buildTraefikLabels(
      app.name,
      this.ctx.appStorage.routedDomains(app, this.ctx.tenants),
      app.internalPort,
    )
    return this.ctx.docker.run({
      name: app.name,
      image,
      internalPort: app.internalPort,
      env: app.env,
      volumes: app.volumes,
      restartPolicy: app.restartPolicy,
      network: "siteio-network",
      labels,
    })
  }

  /**
   * Deploy a compose app: (re)write the siteio override and bring the project
   * up. Throws DeployError.
   */
  private async deployComposeApp(app: App, deployedBy?: string): Promise<{ updated: App; warnings: string[] }> {
    const { name, compose } = app
    if (!compose) throw new DeployError("Not a compose app", 400)
    if (!this.ctx.docker.isAvailable()) throw new DeployError("Docker is not available", 500)
    try {
      // Ensure Traefik can reach the service
      this.ctx.docker.ensureNetwork()

      // Resolve base compose file (git stacks are cloned first)
      if (compose.source === "git") {
        if (!app.git) throw new DeployError("Git source missing on compose app", 500)
        await this.ctx.git.clone(name, app.git.repoUrl, app.git.branch, app.git.token)
      }
      const basePath = this.composeBasePath(app)
      if (!existsSync(basePath)) {
        throw new DeployError(
          compose.source === "git" ? `Compose file not found at '${compose.path}'` : "Compose file not found for app",
          400,
        )
      }

      const { containerId, warnings } = await this.composeUpApp(app)

      const commitHash = compose.source === "git" ? await this.ctx.git.getCommitHash(name) : undefined

      const updated = this.ctx.appStorage.update(name, {
        status: "running",
        containerId,
        deployedAt: new Date().toISOString(),
        lastBuildAt: new Date().toISOString(),
        ...(commitHash && { commitHash }),
      })
      if (!updated) throw new DeployError("App not found", 404)
      this.pageApp(updated, "deployed", deployedBy)
      return { updated, warnings }
    } catch (err) {
      this.ctx.appStorage.update(name, { status: "failed" })
      const message = err instanceof Error ? err.message : "Failed to deploy app"
      this.pageAppFailure(app, message, deployedBy)
      if (err instanceof DeployError) throw err
      throw new DeployError(message, 500)
    }
  }

  /**
   * Deploy a single-container app: build or pull the new image while the old
   * container keeps running, then swap. `ref` overrides the git branch (a tag,
   * for auto-deploy). Throws DeployError.
   */
  async deployContainerApp(
    name: string,
    opts: { ref?: string; noCache?: boolean; dockerfileContent?: string; deployedBy?: string } = {},
  ): Promise<App> {
    const app = this.ctx.appStorage.get(name)
    if (!app) throw new DeployError("App not found", 404)
    if (app.compose) throw new DeployError("Compose apps are not single-container apps", 400)
    if (this.ctx.isDeploying(name)) throw new DeployError("Deploy already in progress", 409)

    this.ctx.addDeploying(name)
    let swapped = false
    try {
      if (!this.ctx.docker.isAvailable()) throw new DeployError("Docker is not available", 500)
      this.ctx.docker.ensureNetwork()

      let imageToRun: string
      let commitHash: string | undefined
      let lastBuildAt: string | undefined

      if (app.git) {
        await this.ctx.git.clone(name, app.git.repoUrl, opts.ref ?? app.git.branch, app.git.token)
        const repoPath = this.ctx.git.repoPath(name)

        // Context and Dockerfile paths are relative to the repo root, like
        // docker -f, and never leave it: the build would read the agent's data.
        const contextPath = app.git.context ? join(repoPath, app.git.context) : repoPath
        const dockerfilePath = join(repoPath, app.git.dockerfile)
        const inRepo = (path: string) =>
          resolve(path) === resolve(repoPath) || resolve(path).startsWith(resolve(repoPath) + sep)
        if (!inRepo(contextPath) || !inRepo(dockerfilePath)) {
          throw new DeployError("Build context and Dockerfile can't be outside the repository", 400)
        }
        if (app.git.context && !existsSync(contextPath)) {
          throw new DeployError(`Context directory not found at '${app.git.context}'`, 400)
        }
        if (!existsSync(dockerfilePath)) {
          throw new DeployError(`Dockerfile not found at '${app.git.dockerfile}'`, 400)
        }
        // The repo is the app's: a committed symlink can still point out of
        // it, and Docker follows it.
        const realRepo = realpathSync(repoPath)
        const realInRepo = (path: string) =>
          realpathSync(path) === realRepo || realpathSync(path).startsWith(realRepo + sep)
        if (!realInRepo(contextPath) || !realInRepo(dockerfilePath)) {
          throw new DeployError("Build context and Dockerfile can't be outside the repository", 400)
        }

        imageToRun = this.ctx.docker.imageTag(name)
        await this.ctx.docker.build({ contextPath, dockerfilePath, tag: imageToRun, noCache: opts.noCache })
        commitHash = await this.ctx.git.getCommitHash(name)
        lastBuildAt = new Date().toISOString()
      } else if (app.dockerfile) {
        // Inline-dockerfile app: build from the stored Dockerfile in an empty context.
        // The Dockerfile must be self-contained (no COPY/ADD from context).
        if (opts.dockerfileContent) this.ctx.dockerfiles.write(name, opts.dockerfileContent)
        if (!this.ctx.dockerfiles.exists(name)) {
          throw new DeployError("Dockerfile not found for app — re-run deploy with -f", 400)
        }
        imageToRun = this.ctx.docker.imageTag(name)
        await this.ctx.docker.build({
          contextPath: this.ctx.dockerfiles.contextPath(name),
          dockerfilePath: this.ctx.dockerfiles.dockerfilePath(name),
          tag: imageToRun,
          noCache: opts.noCache,
        })
        lastBuildAt = new Date().toISOString()
      } else {
        // Image-based app: pull from registry
        await this.ctx.docker.pull(app.image)
        imageToRun = app.image
      }

      imageToRun = await this.tenantSafeImage(name, imageToRun)

      // The new image is ready: only now replace the running container, if
      // the app still exists.
      if (!this.ctx.appStorage.get(name)) throw new DeployError("App not found", 404)
      swapped = true
      const containerId = await this.runAppContainer(app, imageToRun)

      const updated = this.ctx.appStorage.update(name, {
        status: "running",
        containerId,
        deployedAt: new Date().toISOString(),
        autoDeployError: undefined,
        ...(commitHash && { commitHash }),
        ...(lastBuildAt && { lastBuildAt }),
      })
      if (!updated) throw new DeployError("App not found", 404)
      this.pageApp(updated, "deployed", opts.deployedBy)

      // Refresh the card preview in the background — deploy stays fast.
      this.captureAppThumbnail(updated)
      return updated
    } catch (err) {
      // Before the swap an existing container is untouched, so its status
      // stands; with none, nothing is running.
      if (swapped || !this.ctx.docker.containerExists(name)) this.ctx.appStorage.update(name, { status: "failed" })
      const message = err instanceof Error ? err.message : "Failed to deploy app"
      this.pageAppFailure(app, message, opts.deployedBy)
      if (err instanceof DeployError) throw err
      throw new DeployError(message, 500)
    } finally {
      this.ctx.deleteDeploying(name)
    }
  }

  // Take an app offline: stop its containers and turn their restart policy
  // off, so Traefik has no route and a reboot can't revive them. The
  // containers stay, so their anonymous volumes come back on `start`.
  async handleStopApp(name: string, req: Request, scope: Scope): Promise<Response> {
    const app = this.ctx.appStorage.get(name)
    if (!app) {
      return this.ctx.error("App not found", 404)
    }
    if (app.status === "stopped")
      return this.ctx.error(`App '${this.ctx.tenants.displayName(name, scope)}' is already stopped`, 409)
    if (this.ctx.isDeploying(name)) {
      return this.ctx.error("Deploy already in progress", 409)
    }
    try {
      // Containers stay (their anonymous volumes with them); with the restart
      // policy off, a daemon or server restart can't bring them back.
      if (app.compose) {
        const files = this.composeFiles(app)
        const envFile = this.writeComposeEnvFile(app)
        await this.ctx.docker.composeStop(`siteio-${name}`, files, envFile)
        for (const s of await this.ctx.docker.composePs(`siteio-${name}`, files, envFile)) {
          await this.ctx.docker.setRestartPolicy(s.containerId, "no")
        }
      } else if (this.ctx.docker.containerExists(name)) {
        await this.ctx.docker.stop(name)
        await this.ctx.docker.setRestartPolicy(this.ctx.docker.containerName(name), "no")
      }
      const updated = this.ctx.appStorage.update(name, { status: "stopped" })!
      this.pageApp(updated, "stopped", this.ctx.requestUser(req))
      return this.ctx.json(this.appView(updated, scope))
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to stop app"
      return this.ctx.error(message, 500)
    }
  }

  // Bring a stopped app back. Single container: the same container, with its
  // restart policy put back; settings changed while stopped apply on the next
  // deploy. Gone container: recreate it from the image on the server, or
  // deploy when that is gone too. Compose: `compose up` (unchanged containers
  // are reused), then each service's restart policy put back.
  private async startApp(app: App, by?: string): Promise<App> {
    if (!this.ctx.docker.isAvailable()) throw new DeployError("Docker is not available", 500)
    this.ctx.docker.ensureNetwork()
    const name = app.name
    const image = app.git || app.dockerfile ? this.ctx.docker.imageTag(name) : app.image
    const hasContainer = !app.compose && this.ctx.docker.containerExists(name)
    if (!app.compose && !hasContainer && !this.ctx.docker.imageExists(image))
      return this.deployContainerApp(name, { deployedBy: by })
    try {
      let containerId = app.containerId
      if (app.compose) {
        containerId = (await this.composeUpApp(app)).containerId
        const { spec } = await this.resolveComposeBase(app)
        const project = `siteio-${name}`
        const files = this.composeFiles(app)
        for (const s of await this.ctx.docker.composePs(project, files, this.writeComposeEnvFile(app))) {
          const svc = spec.services[s.service] as
            | { restart?: string; deploy?: { restart_policy?: { condition?: string } } }
            | undefined
          // Compose v2 maps deploy.restart_policy.condition to the container policy when `restart` is unset
          const restart =
            svc?.restart ??
            ({ any: "always", "on-failure": "on-failure" } as Record<string, string>)[
              svc?.deploy?.restart_policy?.condition ?? ""
            ] ??
            "no"
          await this.ctx.docker.setRestartPolicy(s.containerId, restart)
        }
      } else if (hasContainer) {
        await this.ctx.docker.setRestartPolicy(this.ctx.docker.containerName(name), app.restartPolicy)
        await this.ctx.docker.start(name)
      } else {
        containerId = await this.runAppContainer(app, await this.tenantSafeImage(name, image))
      }
      const updated = this.ctx.appStorage.update(name, { status: "running", containerId })
      if (!updated) throw new DeployError("App not found", 404)
      this.pageApp(updated, "started", by)
      return updated
    } catch (err) {
      this.ctx.appStorage.update(name, { status: "failed" })
      if (err instanceof DeployError) throw err
      throw new DeployError(err instanceof Error ? err.message : "Failed to start app", 500)
    }
  }

  async handleStartApp(name: string, req: Request, scope: Scope): Promise<Response> {
    const app = this.ctx.appStorage.get(name)
    if (!app) return this.ctx.error("App not found", 404)
    if (app.status !== "stopped")
      return this.ctx.error(`App '${this.ctx.tenants.displayName(name, scope)}' is not stopped`, 409)
    if (this.ctx.isDeploying(name)) return this.ctx.error("Deploy already in progress", 409)
    try {
      const updated = await this.startApp(app, this.ctx.requestUser(req))
      return this.ctx.json(this.appView(updated, scope))
    } catch (err) {
      const status = err instanceof DeployError ? err.status : 500
      return this.ctx.error(err instanceof Error ? err.message : "Failed to start app", status)
    }
  }

  async handleRestartApp(name: string, req: Request, scope: Scope): Promise<Response> {
    const app = this.ctx.appStorage.get(name)
    if (!app) {
      return this.ctx.error("App not found", 404)
    }
    if (this.ctx.isDeploying(name)) {
      return this.ctx.error("Deploy already in progress", 409)
    }
    if (app.status === "stopped") return this.handleStartApp(name, req, scope)
    try {
      if (app.compose) {
        const files = this.composeFiles(app)
        await this.ctx.docker.composeRestart(`siteio-${name}`, files, this.writeComposeEnvFile(app))
        const updated = this.ctx.appStorage.update(name, { status: "running" })
        this.pageApp(app, "restarted", this.ctx.requestUser(req))
        return this.ctx.json(updated && this.appView(updated, scope))
      }
      if (this.ctx.docker.containerExists(name)) {
        await this.ctx.docker.restart(name)
        const updated = this.ctx.appStorage.update(name, { status: "running" })
        this.pageApp(app, "restarted", this.ctx.requestUser(req))
        return this.ctx.json(updated && this.appView(updated, scope))
      }
      return this.ctx.error("Container does not exist. Deploy the app first.", 400)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to restart app"
      return this.ctx.error(message, 500)
    }
  }

  async handleGetAppStatus(name: string, scope: Scope): Promise<Response> {
    const app = this.ctx.appStorage.get(name)
    if (!app) {
      return this.ctx.error("App not found", 404)
    }

    try {
      let services: AppServiceStatus[]
      if (app.compose) {
        const primary = app.compose.primaryService
        const files = this.composeFiles(app)
        const ps = await this.ctx.docker.composePs(`siteio-${name}`, files, this.writeComposeEnvFile(app))
        services = ps.map(({ containerId: _id, ...s }) => ({ ...s, primary: s.service === primary }))
        if (!services.some((s) => s.primary)) {
          services.unshift({ service: primary, primary: true, state: "missing" })
        }
      } else {
        const inspect = await this.ctx.docker.inspect(name)
        const service = this.ctx.tenants.displayName(name, scope)
        services = [
          inspect
            ? { service, primary: true, state: inspect.state.status, exitCode: inspect.state.exitCode }
            : { service, primary: true, state: "missing" },
        ]
      }

      const response: AppStatus = { name: this.ctx.tenants.displayName(name, scope), services }
      return this.ctx.json(response)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to get app status"
      return this.ctx.error(message, 500)
    }
  }

  async handleGetAppLogs(name: string, url: URL, scope: Scope): Promise<Response> {
    const app = this.ctx.appStorage.get(name)
    if (!app) {
      return this.ctx.error("App not found", 404)
    }

    const tail = parseInt(url.searchParams.get("tail") || "100", 10)
    const service = url.searchParams.get("service") || undefined
    const all = url.searchParams.get("all") === "true"

    if ((service || all) && !app.compose) {
      return this.ctx.error("`service` and `all` are only valid on compose-based apps", 400)
    }

    try {
      let logs: string
      if (app.compose) {
        const files = this.composeFiles(app)
        logs = await this.ctx.docker.composeLogs(`siteio-${name}`, files, this.writeComposeEnvFile(app), {
          tail,
          all,
          service: all ? undefined : (service ?? app.compose.primaryService),
        })
      } else {
        logs = await this.ctx.docker.logs(name, tail)
      }

      const response: ContainerLogs = { name: this.ctx.tenants.displayName(name, scope), logs, lines: tail }
      return this.ctx.json(response)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to get logs"
      return this.ctx.error(message, 500)
    }
  }

  // Regenerate an app's preview on demand.
  async handleRefreshAppThumbnail(name: string): Promise<Response> {
    const app = this.ctx.appStorage.get(name)
    if (!app) return this.ctx.error("App not found", 404)
    if (app.compose) return this.ctx.error("Previews aren't available for compose apps", 422)
    if (!this.ctx.thumbnails) return this.ctx.error("Thumbnails are not available", 503)
    if (!this.ctx.docker.isAvailable()) return this.ctx.error("Docker is not available", 500)
    const result = await this.ctx.thumbnails.capture(name, this.appInternalUrl(app))
    if (!result.ok) return this.ctx.error(result.reason || "Failed to capture thumbnail", 502)
    return this.ctx.json({ generated: true })
  }

  // A single-container app is reachable on siteio-network at its container name
  // + its internal port. (Compose apps have non-deterministic container names on
  // the shared network, so previews are skipped for them — see captureAppThumbnail.)
  private appInternalUrl(app: App): string {
    return `http://${this.ctx.docker.containerName(app.name)}:${app.internalPort}`
  }

  // Preview an app after deploy. Only single-container apps are captured; a
  // compose app's primary service isn't reliably addressable by name here.
  private captureAppThumbnail(app: App): void {
    if (app.compose) return
    this.ctx.captureThumbnail(app.name, this.appInternalUrl(app))
  }

  private pageAppFailure(app: App, error: string, by?: string): void {
    this.ctx.pager?.notify({
      title: `App '${app.name}' deploy failed`,
      message: [error, by && `by ${by}`].filter(Boolean).join(" · "),
      url: this.ctx.appStorage.url(app, this.ctx.tenants),
    })
  }

  private pageApp(app: App, event: "deployed" | "restarted" | "stopped" | "started", by?: string): void {
    const url = this.ctx.appStorage.url(app, this.ctx.tenants)
    this.ctx.pager?.notify({
      title: `App '${app.name}' ${event}`,
      message: [
        event === "deployed" && app.commitHash && `commit ${app.commitHash.slice(0, 7)}`,
        by && `by ${by}`,
        `on ${this.ctx.config.domain}`,
      ]
        .filter(Boolean)
        .join(" · "),
      url,
    })
    if (event === "deployed") {
      this.ctx.ranking?.report({ user: by, version: app.commitHash?.slice(0, 7) ?? app.image, url })
    }
  }

  /**
   * Resolve an app's compose file alone with `docker compose config`: it must
   * parse and contain the primary service. Returns the resolved config and its
   * warnings; throws ValidationError otherwise.
   */
  private async resolveComposeBase(
    app: Pick<App, "name" | "domains" | "compose">,
  ): Promise<{ spec: ComposeSpec; warnings: string[] }> {
    const { primaryService, source } = app.compose!
    let spec: ComposeSpec
    try {
      spec = await this.ctx.docker.composeConfig(
        `siteio-${app.name}`,
        [this.composeBasePath(app)],
        this.writeComposeEnvFile(app),
      )
    } catch (err) {
      throw new ValidationError(err instanceof Error ? err.message : String(err))
    }
    const missing = missingPrimaryService(spec, primaryService)
    if (missing) throw new ValidationError(missing)
    // Relative bind mounts resolve under the upload folder, which holds only the compose file
    const uploadedRoot = source === "inline" ? this.ctx.compose.rootDir() : undefined
    return { spec, warnings: composeWarnings(spec, primaryService, uploadedRoot) }
  }

  /**
   * Check an uploaded compose file when it is stored, so an invalid file or
   * unknown service fails now, not at deploy. Skipped when docker is unavailable.
   */
  private async checkUploadedCompose(app: Pick<App, "name" | "domains" | "compose">): Promise<string[]> {
    if (!this.ctx.docker.isAvailable()) return []
    return (await this.resolveComposeBase(app)).warnings
  }

  /**
   * Env file for every docker compose call on an app. It gives compose files
   * `${SITEIO_URL}`, `${SITEIO_DOMAIN}` and `${SITEIO_APP}` for interpolation,
   * followed by the user's own .env: the uploaded one, or for git stacks the
   * repo's .env next to the compose file (--env-file stops compose loading it).
   * Rebuilt on each call so domain changes apply.
   */
  private writeComposeEnvFile(app: Pick<App, "name" | "domains" | "compose">): string {
    const [domain] = this.ctx.appStorage.routedDomains(app, this.ctx.tenants)
    const userEnv = this.ctx.compose.envFileExists(app.name)
      ? this.ctx.compose.baseEnvPath(app.name)
      : app.compose?.source === "git"
        ? join(dirname(this.composeBasePath(app)), ".env")
        : undefined
    return this.ctx.compose.writeSiteioEnv(
      app.name,
      { SITEIO_APP: app.name, SITEIO_DOMAIN: domain!, SITEIO_URL: `https://${domain}` },
      userEnv,
    )
  }

  /**
   * Resolve the [base, override] compose file paths for a compose-based app.
   * For git apps the base lives inside the cloned repo (which must already exist
   * from a prior deploy — lifecycle ops never re-clone).
   */
  private composeFiles(app: App): string[] {
    return [this.composeBasePath(app), this.ctx.compose.overridePath(app.name)]
  }

  /** The user's compose file: the uploaded copy, or the file inside the cloned repo. */
  private composeBasePath(app: Pick<App, "name" | "compose">): string {
    if (!app.compose) {
      throw new Error(`composeBasePath called on non-compose app '${app.name}'`)
    }
    return app.compose.source === "inline"
      ? this.ctx.compose.baseInlinePath(app.name)
      : join(this.ctx.git.repoPath(app.name), app.compose.path)
  }
}
