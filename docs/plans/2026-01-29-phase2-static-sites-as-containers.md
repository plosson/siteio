# Phase 2: Static Sites as Containers - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Convert static site deployment to use nginx containers instead of the custom fileserver, and add `/auth/check` endpoint for OAuth authorization.

**Architecture:** Static sites will run as nginx containers with volume-mounted files. OAuth authorization moves from fileserver.ts to a new `/auth/check` endpoint that Traefik calls via forwardAuth middleware. The fileserver.ts file will be deleted.

**Tech Stack:** TypeScript, Bun, Docker (nginx:alpine), Traefik forwardAuth

---

## Overview

Phase 1 added Docker container support for deploying custom images. Phase 2 unifies static sites under the same container model:

1. When `POST /sites/:subdomain` is called, we now:
   - Extract zip to `<dataDir>/sites/<name>/` (unchanged)
   - Create an App record with `type: "static"` and `image: "nginx:alpine"`
   - Run nginx container with volume mount to extracted files
   - Traefik routes directly to the nginx container

2. OAuth authorization moves from `fileserver.ts` to a new `/auth/check` endpoint

3. `fileserver.ts` is deleted - nginx serves static files better

---

## Task 1: Add `/auth/check` Endpoint

The `/auth/check` endpoint is called by Traefik's forwardAuth middleware to check if an authenticated user is allowed to access a specific site/app.

**Files:**
- Modify: `src/lib/agent/server.ts:62-98` (add handler in handleRequest)

**Step 1: Write the failing test**

Add to `src/__tests__/auth-check.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { AgentServer } from "../lib/agent/server.ts"
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs"
import { join } from "path"

describe("Auth Check Endpoint", () => {
  const TEST_DATA_DIR = join(import.meta.dir, ".test-data-auth-check")
  const TEST_API_KEY = "test-api-key-auth"
  const TEST_DOMAIN = "test.siteio.me"
  let server: AgentServer
  let baseUrl: string

  beforeAll(async () => {
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true })
    }
    mkdirSync(TEST_DATA_DIR, { recursive: true })

    server = new AgentServer({
      domain: TEST_DOMAIN,
      apiKey: TEST_API_KEY,
      dataDir: TEST_DATA_DIR,
      maxUploadSize: 10 * 1024 * 1024,
      skipTraefik: true,
      port: 3098,
    })

    await server.start()
    baseUrl = "http://localhost:3098"
  })

  afterAll(() => {
    server.stop()
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true })
    }
  })

  beforeEach(() => {
    // Clean apps directory before each test
    const appsDir = join(TEST_DATA_DIR, "apps")
    if (existsSync(appsDir)) {
      rmSync(appsDir, { recursive: true })
    }
    mkdirSync(appsDir, { recursive: true })
  })

  it("returns 200 for app without OAuth", async () => {
    // Create app without OAuth
    const createRes = await fetch(`${baseUrl}/apps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": TEST_API_KEY,
      },
      body: JSON.stringify({
        name: "public-app",
        image: "nginx:alpine",
        internalPort: 80,
      }),
    })
    expect(createRes.ok).toBe(true)

    // Check auth - should allow anyone
    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        "Host": `public-app.${TEST_DOMAIN}`,
      },
    })
    expect(checkRes.status).toBe(200)
  })

  it("returns 401 when OAuth required but no email header", async () => {
    // Create app with OAuth
    const createRes = await fetch(`${baseUrl}/apps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": TEST_API_KEY,
      },
      body: JSON.stringify({
        name: "protected-app",
        image: "nginx:alpine",
        internalPort: 80,
        oauth: {
          allowedEmails: ["allowed@example.com"],
        },
      }),
    })
    expect(createRes.ok).toBe(true)

    // Check auth without email header
    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        "Host": `protected-app.${TEST_DOMAIN}`,
      },
    })
    expect(checkRes.status).toBe(401)
  })

  it("returns 200 when email is in allowedEmails", async () => {
    // Create app with OAuth
    await fetch(`${baseUrl}/apps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": TEST_API_KEY,
      },
      body: JSON.stringify({
        name: "email-app",
        image: "nginx:alpine",
        internalPort: 80,
        oauth: {
          allowedEmails: ["allowed@example.com"],
        },
      }),
    })

    // Check auth with allowed email
    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        "Host": `email-app.${TEST_DOMAIN}`,
        "X-Forwarded-Email": "allowed@example.com",
      },
    })
    expect(checkRes.status).toBe(200)
  })

  it("returns 403 when email not in allowedEmails", async () => {
    await fetch(`${baseUrl}/apps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": TEST_API_KEY,
      },
      body: JSON.stringify({
        name: "restricted-app",
        image: "nginx:alpine",
        internalPort: 80,
        oauth: {
          allowedEmails: ["allowed@example.com"],
        },
      }),
    })

    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        "Host": `restricted-app.${TEST_DOMAIN}`,
        "X-Forwarded-Email": "notallowed@example.com",
      },
    })
    expect(checkRes.status).toBe(403)
  })

  it("returns 200 when email matches allowedDomain", async () => {
    await fetch(`${baseUrl}/apps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": TEST_API_KEY,
      },
      body: JSON.stringify({
        name: "domain-app",
        image: "nginx:alpine",
        internalPort: 80,
        oauth: {
          allowedDomain: "company.com",
        },
      }),
    })

    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        "Host": `domain-app.${TEST_DOMAIN}`,
        "X-Forwarded-Email": "employee@company.com",
      },
    })
    expect(checkRes.status).toBe(200)
  })

  it("returns 200 for app not found (passthrough)", async () => {
    // Unknown app should pass through (404 will come from nginx later)
    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        "Host": `nonexistent.${TEST_DOMAIN}`,
      },
    })
    expect(checkRes.status).toBe(200)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/auth-check.test.ts`
Expected: FAIL with endpoint returning 404 (not implemented)

**Step 3: Write the implementation**

In `src/lib/agent/server.ts`, add the auth check handler method:

```typescript
private handleAuthCheck(req: Request): Response {
  const host = req.headers.get("Host") || ""
  const hostWithoutPort = host.split(":")[0]

  // Extract app name from host
  if (!hostWithoutPort || !hostWithoutPort.endsWith(`.${this.config.domain}`)) {
    // Not a valid subdomain request - allow through
    return new Response(null, { status: 200 })
  }

  const appName = hostWithoutPort.slice(0, -(this.config.domain.length + 1))

  // Skip api subdomain
  if (appName === "api") {
    return new Response(null, { status: 200 })
  }

  // Get app from storage
  const app = this.appStorage.get(appName)
  if (!app) {
    // App not found - allow through (nginx will return 404)
    return new Response(null, { status: 200 })
  }

  // No OAuth configured - allow all
  if (!app.oauth) {
    return new Response(null, { status: 200 })
  }

  // Get email from auth headers (set by oauth2-proxy)
  const email = req.headers.get("X-Forwarded-Email") || req.headers.get("X-Auth-Request-Email")

  if (!email) {
    return new Response(null, { status: 401 })
  }

  const normalizedEmail = email.toLowerCase()
  const { allowedEmails, allowedDomain, allowedGroups } = app.oauth

  // Build combined list of allowed emails
  const allAllowedEmails = new Set<string>()

  if (allowedEmails) {
    for (const e of allowedEmails) {
      allAllowedEmails.add(e.toLowerCase())
    }
  }

  if (allowedGroups) {
    const groupEmails = this.groups.resolveGroups(allowedGroups)
    for (const e of groupEmails) {
      allAllowedEmails.add(e.toLowerCase())
    }
  }

  // Check authorization
  let isAllowed = false

  if (allAllowedEmails.size > 0 && allAllowedEmails.has(normalizedEmail)) {
    isAllowed = true
  }

  if (allowedDomain) {
    const emailDomain = normalizedEmail.split("@")[1]
    if (emailDomain === allowedDomain.toLowerCase()) {
      isAllowed = true
    }
  }

  // If no restrictions set, allow all authenticated users
  if (allAllowedEmails.size === 0 && !allowedDomain) {
    isAllowed = true
  }

  return new Response(null, { status: isAllowed ? 200 : 403 })
}
```

Then add the route in `handleRequest` after the health check (no auth required):

```typescript
// Auth check for forwardAuth (no API key required)
if (path === "/auth/check" && req.method === "GET") {
  return this.handleAuthCheck(req)
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/auth-check.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/agent/server.ts src/__tests__/auth-check.test.ts
git commit -m "$(cat <<'EOF'
feat: add /auth/check endpoint for Traefik forwardAuth

This endpoint is called by Traefik to authorize requests to protected
apps. It checks if the authenticated user's email is allowed based on
the app's OAuth configuration (allowedEmails, allowedDomain, allowedGroups).

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Update AppStorage to Accept OAuth in Create

Currently AppStorage.create doesn't accept OAuth settings. We need to add this so static site deployment can set OAuth during app creation.

**Files:**
- Modify: `src/lib/agent/app-storage.ts:34-65` (create method)
- Modify: `src/lib/agent/server.ts:496-538` (handleCreateApp)

**Step 1: Write the failing test**

Add to `src/__tests__/app-storage.test.ts`:

```typescript
it("creates app with oauth settings", () => {
  const app = storage.create({
    name: "oauth-test",
    type: "container",
    image: "nginx:alpine",
    internalPort: 80,
    oauth: {
      allowedEmails: ["test@example.com"],
      allowedDomain: "example.com",
    },
  })

  expect(app.oauth).toBeDefined()
  expect(app.oauth?.allowedEmails).toEqual(["test@example.com"])
  expect(app.oauth?.allowedDomain).toBe("example.com")
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/app-storage.test.ts`
Expected: FAIL (oauth not passed through)

**Step 3: Write the implementation**

In `src/lib/agent/app-storage.ts`, update the create method input type and implementation:

```typescript
create(appData: {
  name: string
  type: "static" | "container"
  image: string
  internalPort: number
  domains?: string[]
  env?: Record<string, string>
  volumes?: Array<{ name: string; mountPath: string }>
  restartPolicy?: "always" | "unless-stopped" | "on-failure" | "no"
  status?: ContainerStatus
  oauth?: SiteOAuth
}): App {
  // ... existing validation ...

  const app: App = {
    name: appData.name,
    type: appData.type,
    image: appData.image,
    internalPort: appData.internalPort,
    domains: appData.domains || [],
    env: appData.env || {},
    volumes: appData.volumes || [],
    restartPolicy: appData.restartPolicy || "unless-stopped",
    status: appData.status || "pending",
    oauth: appData.oauth,  // Add this line
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  // ... rest of method ...
}
```

Also update `handleCreateApp` in server.ts to accept oauth:

```typescript
private async handleCreateApp(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as {
      name: string
      type?: string
      image: string
      internalPort: number
      domains?: string[]
      env?: Record<string, string>
      volumes?: Array<{ name: string; mountPath: string }>
      restartPolicy?: string
      oauth?: SiteOAuth  // Add this
    }

    // ... validation ...

    const app = this.appStorage.create({
      name: body.name,
      type: (body.type as "static" | "container") || "container",
      image: body.image,
      internalPort: body.internalPort,
      domains: body.domains || [],
      env: body.env || {},
      volumes: body.volumes || [],
      restartPolicy: (body.restartPolicy as "always" | "unless-stopped" | "on-failure" | "no") || "unless-stopped",
      status: "pending",
      oauth: body.oauth,  // Add this
    })

    return this.json(app)
  } catch (err) {
    // ...
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/app-storage.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/agent/app-storage.ts src/lib/agent/server.ts src/__tests__/app-storage.test.ts
git commit -m "$(cat <<'EOF'
feat: allow OAuth settings when creating apps

Apps can now have OAuth settings (allowedEmails, allowedDomain,
allowedGroups) set during creation, which is needed for static site
deployment to work with OAuth protection.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Add Helper Method to Create Static Site App Record

Add a method to create an App record for a static site with proper defaults (nginx:alpine, volume mount, etc.).

**Files:**
- Modify: `src/lib/agent/app-storage.ts` (add createStaticSiteApp method)

**Step 1: Write the failing test**

Add to `src/__tests__/app-storage.test.ts`:

```typescript
it("creates static site app with correct defaults", () => {
  const app = storage.createStaticSiteApp("mysite", "/data/sites/mysite", {
    allowedEmails: ["user@example.com"],
  })

  expect(app.name).toBe("mysite")
  expect(app.type).toBe("static")
  expect(app.image).toBe("nginx:alpine")
  expect(app.internalPort).toBe(80)
  expect(app.volumes).toHaveLength(1)
  expect(app.volumes[0].name).toBe("/data/sites/mysite")
  expect(app.volumes[0].mountPath).toBe("/usr/share/nginx/html")
  expect(app.oauth?.allowedEmails).toEqual(["user@example.com"])
})

it("creates static site app without oauth", () => {
  const app = storage.createStaticSiteApp("public-site", "/data/sites/public-site")

  expect(app.name).toBe("public-site")
  expect(app.type).toBe("static")
  expect(app.oauth).toBeUndefined()
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/app-storage.test.ts`
Expected: FAIL (method doesn't exist)

**Step 3: Write the implementation**

Add to `src/lib/agent/app-storage.ts`:

```typescript
createStaticSiteApp(name: string, sitePath: string, oauth?: SiteOAuth): App {
  return this.create({
    name,
    type: "static",
    image: "nginx:alpine",
    internalPort: 80,
    restartPolicy: "unless-stopped",
    volumes: [
      {
        name: sitePath,
        mountPath: "/usr/share/nginx/html",
      },
    ],
    oauth,
  })
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/app-storage.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/agent/app-storage.ts src/__tests__/app-storage.test.ts
git commit -m "$(cat <<'EOF'
feat: add createStaticSiteApp helper method

Convenience method to create an App record for static sites with
proper defaults (nginx:alpine, port 80, volume mount to nginx html dir).

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Update DockerManager for Read-Only Volume Mounts

Static sites need read-only volume mounts (`:ro` suffix). Update DockerManager to support this.

**Files:**
- Modify: `src/lib/agent/docker.ts:96-130` (run method, buildArgs)
- Modify: `src/types.ts` (VolumeMount type)

**Step 1: Write the failing test**

Add to `src/__tests__/docker.test.ts`:

```typescript
it("builds run args with read-only volume", () => {
  const args = docker.buildRunArgs({
    name: "test-app",
    image: "nginx:alpine",
    internalPort: 80,
    env: {},
    volumes: [{ name: "/data/sites/mysite", mountPath: "/usr/share/nginx/html", readonly: true }],
    restartPolicy: "unless-stopped",
    network: "siteio-network",
    labels: {},
  })

  expect(args).toContain("-v")
  const vIndex = args.indexOf("-v")
  expect(args[vIndex + 1]).toBe("/data/sites/mysite:/usr/share/nginx/html:ro")
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/docker.test.ts`
Expected: FAIL (readonly not handled)

**Step 3: Write the implementation**

Update `src/types.ts` VolumeMount:

```typescript
export interface VolumeMount {
  name: string      // Host path or named volume
  mountPath: string // Container path
  readonly?: boolean // Optional read-only flag
}
```

Update `src/lib/agent/docker.ts` buildRunArgs:

```typescript
// Add volumes
if (config.volumes) {
  for (const vol of config.volumes) {
    const volumeSpec = vol.readonly
      ? `${vol.name}:${vol.mountPath}:ro`
      : `${vol.name}:${vol.mountPath}`
    args.push("-v", volumeSpec)
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/docker.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/agent/docker.ts src/types.ts src/__tests__/docker.test.ts
git commit -m "$(cat <<'EOF'
feat: support read-only volume mounts in DockerManager

Add optional readonly flag to VolumeMount type and handle :ro suffix
in docker run arguments. Needed for static sites to mount files
as read-only into nginx containers.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Update AppStorage.createStaticSiteApp to Use Read-Only Mount

Update the helper to set readonly: true for static site volume mounts.

**Files:**
- Modify: `src/lib/agent/app-storage.ts` (createStaticSiteApp)

**Step 1: Write the failing test**

Update the existing test in `src/__tests__/app-storage.test.ts`:

```typescript
it("creates static site app with read-only volume mount", () => {
  const app = storage.createStaticSiteApp("mysite", "/data/sites/mysite")

  expect(app.volumes[0].readonly).toBe(true)
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/app-storage.test.ts`
Expected: FAIL (readonly not set)

**Step 3: Write the implementation**

Update `createStaticSiteApp`:

```typescript
createStaticSiteApp(name: string, sitePath: string, oauth?: SiteOAuth): App {
  return this.create({
    name,
    type: "static",
    image: "nginx:alpine",
    internalPort: 80,
    restartPolicy: "unless-stopped",
    volumes: [
      {
        name: sitePath,
        mountPath: "/usr/share/nginx/html",
        readonly: true,  // Add this
      },
    ],
    oauth,
  })
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/app-storage.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/agent/app-storage.ts src/__tests__/app-storage.test.ts
git commit -m "$(cat <<'EOF'
feat: static site volumes are read-only

Static site files should not be modified by the nginx container,
so mount them as read-only.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Update handleDeploy to Create Container

This is the core change. When a static site is deployed, create an nginx container to serve it.

**Files:**
- Modify: `src/lib/agent/server.ts:226-296` (handleDeploy method)

**Step 1: Write the failing test**

Add to `src/__tests__/sites-as-containers.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { AgentServer } from "../lib/agent/server.ts"
import { mkdirSync, rmSync, existsSync } from "fs"
import { join } from "path"
import { zipSync } from "fflate"

describe("Static Sites as Containers", () => {
  const TEST_DATA_DIR = join(import.meta.dir, ".test-data-sites-containers")
  const TEST_API_KEY = "test-api-key-sites"
  const TEST_DOMAIN = "test.siteio.me"
  let server: AgentServer
  let baseUrl: string

  beforeAll(async () => {
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true })
    }
    mkdirSync(TEST_DATA_DIR, { recursive: true })

    server = new AgentServer({
      domain: TEST_DOMAIN,
      apiKey: TEST_API_KEY,
      dataDir: TEST_DATA_DIR,
      maxUploadSize: 10 * 1024 * 1024,
      skipTraefik: true,
      port: 3099,
    })

    await server.start()
    baseUrl = "http://localhost:3099"
  })

  afterAll(() => {
    server.stop()
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true })
    }
  })

  beforeEach(() => {
    // Clean directories
    for (const dir of ["apps", "sites", "metadata"]) {
      const path = join(TEST_DATA_DIR, dir)
      if (existsSync(path)) {
        rmSync(path, { recursive: true })
      }
      mkdirSync(path, { recursive: true })
    }
  })

  function createTestZip(): Uint8Array {
    return zipSync({
      "index.html": new TextEncoder().encode("<html><body>Test</body></html>"),
    })
  }

  it("creates app record when deploying static site", async () => {
    const zipData = createTestZip()

    // Deploy site
    const deployRes = await fetch(`${baseUrl}/sites/testsite`, {
      method: "POST",
      headers: {
        "Content-Type": "application/zip",
        "X-API-Key": TEST_API_KEY,
      },
      body: zipData,
    })
    expect(deployRes.ok).toBe(true)

    // Check app was created
    const appRes = await fetch(`${baseUrl}/apps/testsite`, {
      headers: { "X-API-Key": TEST_API_KEY },
    })
    expect(appRes.ok).toBe(true)

    const { data: app } = await appRes.json()
    expect(app.name).toBe("testsite")
    expect(app.type).toBe("static")
    expect(app.image).toBe("nginx:alpine")
    expect(app.internalPort).toBe(80)
  })

  it("preserves OAuth when deploying static site", async () => {
    const zipData = createTestZip()

    // Deploy with OAuth
    const deployRes = await fetch(`${baseUrl}/sites/oauthsite`, {
      method: "POST",
      headers: {
        "Content-Type": "application/zip",
        "X-API-Key": TEST_API_KEY,
        "X-Site-OAuth-Emails": "user@example.com",
      },
      body: zipData,
    })
    expect(deployRes.ok).toBe(true)

    // Check app has OAuth
    const appRes = await fetch(`${baseUrl}/apps/oauthsite`, {
      headers: { "X-API-Key": TEST_API_KEY },
    })
    const { data: app } = await appRes.json()
    expect(app.oauth?.allowedEmails).toContain("user@example.com")
  })

  it("redeploys by updating existing app", async () => {
    const zipData = createTestZip()

    // Deploy first time
    await fetch(`${baseUrl}/sites/redeploysite`, {
      method: "POST",
      headers: {
        "Content-Type": "application/zip",
        "X-API-Key": TEST_API_KEY,
      },
      body: zipData,
    })

    // Get creation timestamp
    let appRes = await fetch(`${baseUrl}/apps/redeploysite`, {
      headers: { "X-API-Key": TEST_API_KEY },
    })
    const { data: app1 } = await appRes.json()
    const firstCreatedAt = app1.createdAt

    // Deploy again
    await fetch(`${baseUrl}/sites/redeploysite`, {
      method: "POST",
      headers: {
        "Content-Type": "application/zip",
        "X-API-Key": TEST_API_KEY,
      },
      body: zipData,
    })

    // Check it's the same app (same createdAt)
    appRes = await fetch(`${baseUrl}/apps/redeploysite`, {
      headers: { "X-API-Key": TEST_API_KEY },
    })
    const { data: app2 } = await appRes.json()
    expect(app2.createdAt).toBe(firstCreatedAt)
    expect(app2.updatedAt).not.toBe(app1.updatedAt)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/sites-as-containers.test.ts`
Expected: FAIL (app not created)

**Step 3: Write the implementation**

Update `handleDeploy` in `src/lib/agent/server.ts`:

```typescript
private async handleDeploy(subdomain: string, req: Request): Promise<Response> {
  // ... existing validation ...

  try {
    // Read the zip data
    const zipData = new Uint8Array(await req.arrayBuffer())

    // Check for OAuth headers
    const allowedEmails = req.headers.get("X-Site-OAuth-Emails")
    const allowedDomain = req.headers.get("X-Site-OAuth-Domain")

    let oauth: SiteOAuth | undefined
    if (allowedEmails || allowedDomain) {
      if (!this.hasOAuthEnabled()) {
        return this.error(
          "Google authentication not configured. Run 'siteio agent oauth' on the server to enable it.",
          400
        )
      }

      oauth = {}
      if (allowedEmails) {
        oauth.allowedEmails = allowedEmails.split(",").map((e) => e.trim().toLowerCase())
      }
      if (allowedDomain) {
        oauth.allowedDomain = allowedDomain.toLowerCase()
      }
    }

    // Extract and store files (unchanged)
    const metadata = await this.storage.extractAndStore(subdomain, zipData, oauth)
    const sitePath = this.storage.getSitePath(subdomain)

    // Create or update app record for this static site
    let app = this.appStorage.get(subdomain)
    if (app) {
      // Update existing app (redeploy)
      app = this.appStorage.update(subdomain, {
        oauth,
        updatedAt: new Date().toISOString(),
      })!
    } else {
      // Create new static site app
      app = this.appStorage.createStaticSiteApp(subdomain, sitePath, oauth)
    }

    // Set domain for routing
    const domain = `${subdomain}.${this.config.domain}`
    if (!app.domains.includes(domain)) {
      this.appStorage.update(subdomain, {
        domains: [domain],
      })
    }

    // Deploy the container (pull, run)
    if (this.docker.isAvailable()) {
      this.docker.ensureNetwork()

      // Remove existing container if any
      if (this.docker.containerExists(subdomain)) {
        await this.docker.remove(subdomain)
      }

      // Build Traefik labels
      const labels = this.docker.buildTraefikLabels(subdomain, [domain], 80)

      // Run nginx container
      const containerId = await this.docker.run({
        name: subdomain,
        image: "nginx:alpine",
        internalPort: 80,
        env: {},
        volumes: [{ name: sitePath, mountPath: "/usr/share/nginx/html", readonly: true }],
        restartPolicy: "unless-stopped",
        network: "siteio-network",
        labels,
      })

      // Update app with container info
      this.appStorage.update(subdomain, {
        status: "running",
        containerId,
        deployedAt: new Date().toISOString(),
      })
    }

    // Update Traefik config (still needed for now, will refactor later)
    const allSites = this.storage.listSites()
    this.traefik?.updateDynamicConfig(allSites)

    const siteInfo: SiteInfo = {
      subdomain: metadata.subdomain,
      url: `https://${metadata.subdomain}.${this.config.domain}`,
      size: metadata.size,
      deployedAt: metadata.deployedAt,
      oauth: metadata.oauth,
    }

    return this.json(siteInfo)
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to deploy site"
    return this.error(message, 500)
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/sites-as-containers.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/agent/server.ts src/__tests__/sites-as-containers.test.ts
git commit -m "$(cat <<'EOF'
feat: deploy static sites as nginx containers

When deploying a static site, now also:
1. Create an App record with type=static
2. Run an nginx:alpine container with volume mount
3. Configure Traefik labels for routing

This unifies static sites under the container model.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Update handleUndeploy to Remove Container

When undeploying a static site, also stop and remove the container and app record.

**Files:**
- Modify: `src/lib/agent/server.ts:298-313` (handleUndeploy)

**Step 1: Write the failing test**

Add to `src/__tests__/sites-as-containers.test.ts`:

```typescript
it("removes app and container when undeploying", async () => {
  const zipData = createTestZip()

  // Deploy
  await fetch(`${baseUrl}/sites/todelete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/zip",
      "X-API-Key": TEST_API_KEY,
    },
    body: zipData,
  })

  // Verify app exists
  let appRes = await fetch(`${baseUrl}/apps/todelete`, {
    headers: { "X-API-Key": TEST_API_KEY },
  })
  expect(appRes.ok).toBe(true)

  // Undeploy
  const deleteRes = await fetch(`${baseUrl}/sites/todelete`, {
    method: "DELETE",
    headers: { "X-API-Key": TEST_API_KEY },
  })
  expect(deleteRes.ok).toBe(true)

  // Verify app is gone
  appRes = await fetch(`${baseUrl}/apps/todelete`, {
    headers: { "X-API-Key": TEST_API_KEY },
  })
  expect(appRes.status).toBe(404)
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/sites-as-containers.test.ts`
Expected: FAIL (app still exists after undeploy)

**Step 3: Write the implementation**

Update `handleUndeploy` in `src/lib/agent/server.ts`:

```typescript
private handleUndeploy(subdomain: string): Response {
  if (!this.storage.siteExists(subdomain)) {
    return this.error("Site not found", 404)
  }

  // Stop and remove container if exists
  if (this.docker.containerExists(subdomain)) {
    try {
      this.docker.remove(subdomain)
    } catch {
      // Ignore errors
    }
  }

  // Delete app record if exists
  if (this.appStorage.exists(subdomain)) {
    this.appStorage.delete(subdomain)
  }

  // Delete site files and metadata
  const deleted = this.storage.deleteSite(subdomain)
  if (!deleted) {
    return this.error("Failed to delete site", 500)
  }

  // Update Traefik config
  const allSites = this.storage.listSites()
  this.traefik?.updateDynamicConfig(allSites)

  return this.json(null)
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/sites-as-containers.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/agent/server.ts src/__tests__/sites-as-containers.test.ts
git commit -m "$(cat <<'EOF'
feat: undeploy also removes container and app record

When undeploying a static site, now also:
1. Stop and remove the nginx container
2. Delete the App record

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Update Traefik Config Generation for Container Routing

Currently TraefikManager.generateDynamicConfig routes to the fileserver. Update it to use container labels for routing instead, so Traefik can route directly to nginx containers.

**Files:**
- Modify: `src/lib/agent/traefik.ts:99-209` (generateDynamicConfig)

**Step 1: Write the failing test**

Add to `src/__tests__/traefik.test.ts` (create if not exists):

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { TraefikManager } from "../lib/agent/traefik.ts"
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs"
import { join } from "path"

describe("TraefikManager", () => {
  const TEST_DATA_DIR = join(import.meta.dir, ".test-data-traefik")

  beforeEach(() => {
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true })
    }
    mkdirSync(TEST_DATA_DIR, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true })
    }
  })

  it("generates config with docker provider for container apps", () => {
    const traefik = new TraefikManager({
      dataDir: TEST_DATA_DIR,
      domain: "test.siteio.me",
      httpPort: 80,
      httpsPort: 443,
      fileServerPort: 3000,
    })

    // Static config should include docker provider
    const staticConfig = traefik.generateStaticConfig()
    expect(staticConfig).toContain("docker:")
    expect(staticConfig).toContain("exposedByDefault: false")
  })

  it("only includes API service in dynamic config (containers use labels)", () => {
    const traefik = new TraefikManager({
      dataDir: TEST_DATA_DIR,
      domain: "test.siteio.me",
      httpPort: 80,
      httpsPort: 443,
      fileServerPort: 3000,
    })

    // Dynamic config with no sites should only have API
    const dynamicConfig = traefik.generateDynamicConfig([])
    expect(dynamicConfig).toContain("api-router")
    expect(dynamicConfig).toContain("api-service")
    // Should NOT have site-specific routers (containers use labels)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/traefik.test.ts`
Expected: FAIL (docker provider not in config)

**Step 3: Write the implementation**

Update `generateStaticConfig` in `src/lib/agent/traefik.ts`:

```typescript
generateStaticConfig(): string {
  const { httpPort, httpsPort, email } = this.config

  return `
api:
  dashboard: false
  insecure: false

entryPoints:
  web:
    address: ":${httpPort}"
    http:
      redirections:
        entryPoint:
          to: websecure
          scheme: https
  websecure:
    address: ":${httpsPort}"

providers:
  file:
    filename: /etc/traefik/dynamic.yml
    watch: true
  docker:
    endpoint: "unix:///var/run/docker.sock"
    exposedByDefault: false
    network: siteio-network

certificatesResolvers:
  letsencrypt:
    acme:
      email: ${email || "admin@example.com"}
      storage: /certs/acme.json
      httpChallenge:
        entryPoint: web

log:
  level: INFO
`.trim()
}
```

Update `generateDynamicConfig` to only include API and OAuth routes (sites use container labels):

```typescript
generateDynamicConfig(sites: SiteMetadata[]): string {
  const { domain, fileServerPort, oauthConfig } = this.config
  const routers: Record<string, unknown> = {}
  const services: Record<string, unknown> = {}
  const middlewares: Record<string, unknown> = {}

  const hostUrl = `http://host.docker.internal:${fileServerPort}`
  const oauthProxyUrl = `http://host.docker.internal:${this.oauthProxyPort}`

  // Check if we have protected sites (for oauth2-proxy routes)
  const hasProtectedSites = oauthConfig && sites.some((site) => site.oauth)

  if (hasProtectedSites) {
    services["oauth2-proxy-service"] = {
      loadBalancer: {
        servers: [{ url: oauthProxyUrl }],
      },
    }

    // OAuth2 routes for each protected site
    for (const site of sites) {
      if (site.oauth) {
        routers[`${site.subdomain}-oauth2-router`] = {
          rule: `Host(\`${site.subdomain}.${domain}\`) && PathPrefix(\`/oauth2/\`)`,
          entryPoints: ["websecure"],
          service: "oauth2-proxy-service",
          priority: 100,
          tls: { certResolver: "letsencrypt" },
        }
      }
    }

    routers["api-oauth2-router"] = {
      rule: `Host(\`api.${domain}\`) && PathPrefix(\`/oauth2/\`)`,
      entryPoints: ["websecure"],
      service: "oauth2-proxy-service",
      priority: 100,
      tls: { certResolver: "letsencrypt" },
    }
  }

  // API router only - site routers now come from container labels
  routers["api-router"] = {
    rule: `Host(\`api.${domain}\`)`,
    entryPoints: ["websecure"],
    service: "api-service",
    tls: { certResolver: "letsencrypt" },
  }

  services["api-service"] = {
    loadBalancer: {
      servers: [{ url: hostUrl }],
    },
  }

  // forwardAuth middleware for OAuth-protected apps
  if (oauthConfig) {
    middlewares["siteio-auth"] = {
      forwardAuth: {
        address: `${hostUrl}/auth/check`,
        authRequestHeaders: ["X-Forwarded-Email", "X-Auth-Request-Email", "Host"],
      },
    }
  }

  const config: Record<string, unknown> = {
    http: {
      routers,
      services,
    },
  }

  if (Object.keys(middlewares).length > 0) {
    ;(config.http as Record<string, unknown>).middlewares = middlewares
  }

  return this.toYaml(config)
}
```

Also update the `start` method to mount docker socket:

```typescript
async start(): Promise<void> {
  // ... existing checks ...

  const args = [
    "docker",
    "run",
    "-d",
    "--name",
    TRAEFIK_CONTAINER_NAME,
    "--restart",
    "unless-stopped",
    "--add-host",
    "host.docker.internal:host-gateway",
    "-p",
    `${httpPort}:${httpPort}`,
    "-p",
    `${httpsPort}:${httpsPort}`,
    "-v",
    `${this.configDir}:/etc/traefik:ro`,
    "-v",
    `${this.certsDir}:/certs`,
    "-v",
    "/var/run/docker.sock:/var/run/docker.sock:ro",  // Add this
    TRAEFIK_IMAGE,
    "--configFile=/etc/traefik/traefik.yml",
  ]

  // ... rest of method ...
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/traefik.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/agent/traefik.ts src/__tests__/traefik.test.ts
git commit -m "$(cat <<'EOF'
feat: Traefik uses Docker provider for container routing

- Add Docker provider to Traefik static config
- Mount Docker socket into Traefik container
- Site routers now come from container labels, not dynamic.yml
- Add forwardAuth middleware for OAuth-protected apps

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Update DockerManager.buildTraefikLabels for OAuth

Add forwardAuth middleware label for OAuth-protected apps.

**Files:**
- Modify: `src/lib/agent/docker.ts` (buildTraefikLabels method)

**Step 1: Write the failing test**

Add to `src/__tests__/docker.test.ts`:

```typescript
it("builds Traefik labels with forwardAuth for OAuth", () => {
  const labels = docker.buildTraefikLabels("myapp", ["myapp.example.com"], 80, true)

  expect(labels["traefik.http.routers.siteio-myapp.middlewares"]).toBe("siteio-auth@file")
})

it("builds Traefik labels without forwardAuth when no OAuth", () => {
  const labels = docker.buildTraefikLabels("myapp", ["myapp.example.com"], 80, false)

  expect(labels["traefik.http.routers.siteio-myapp.middlewares"]).toBeUndefined()
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/docker.test.ts`
Expected: FAIL (method signature changed)

**Step 3: Write the implementation**

Update `buildTraefikLabels` in `src/lib/agent/docker.ts`:

```typescript
buildTraefikLabels(
  appName: string,
  domains: string[],
  port: number,
  requireAuth: boolean = false
): Record<string, string> {
  const containerName = this.containerName(appName)
  const labels: Record<string, string> = {
    "traefik.enable": "true",
    [`traefik.http.routers.${containerName}.entrypoints`]: "websecure",
    [`traefik.http.routers.${containerName}.tls.certresolver`]: "letsencrypt",
    [`traefik.http.services.${containerName}.loadbalancer.server.port`]: String(port),
  }

  if (domains.length > 0) {
    const hostRules = domains.map((d) => `Host(\`${d}\`)`).join(" || ")
    labels[`traefik.http.routers.${containerName}.rule`] = hostRules
  }

  if (requireAuth) {
    labels[`traefik.http.routers.${containerName}.middlewares`] = "siteio-auth@file"
  }

  return labels
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/docker.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/agent/docker.ts src/__tests__/docker.test.ts
git commit -m "$(cat <<'EOF'
feat: add forwardAuth middleware label for OAuth apps

buildTraefikLabels now accepts a requireAuth parameter to add the
siteio-auth@file middleware for OAuth-protected apps.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Update handleDeploy to Pass OAuth to Labels

Update handleDeploy to pass the OAuth flag when building Traefik labels.

**Files:**
- Modify: `src/lib/agent/server.ts` (handleDeploy)

**Step 1: Write the failing test**

This is more of an integration test - verify the label is set correctly:

Add to `src/__tests__/sites-as-containers.test.ts`:

```typescript
it("sets forwardAuth middleware for OAuth-protected static site", async () => {
  // This test verifies the integration - when OAuth is set,
  // the container should have the middleware label.
  // Since we can't easily inspect container labels in test,
  // we verify by checking the app record has OAuth set.

  const zipData = createTestZip()

  await fetch(`${baseUrl}/sites/oauthtest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/zip",
      "X-API-Key": TEST_API_KEY,
      "X-Site-OAuth-Emails": "user@example.com",
    },
    body: zipData,
  })

  const appRes = await fetch(`${baseUrl}/apps/oauthtest`, {
    headers: { "X-API-Key": TEST_API_KEY },
  })
  const { data: app } = await appRes.json()

  // OAuth should be set
  expect(app.oauth).toBeDefined()
  expect(app.oauth?.allowedEmails).toContain("user@example.com")
})
```

**Step 2: Run test to verify it passes (already implemented)**

Run: `bun test src/__tests__/sites-as-containers.test.ts`
Expected: PASS (OAuth already preserved)

**Step 3: Update the code**

In handleDeploy, update the buildTraefikLabels call:

```typescript
// Build Traefik labels (with auth if OAuth configured)
const labels = this.docker.buildTraefikLabels(subdomain, [domain], 80, !!oauth)
```

**Step 4: Run all tests**

Run: `bun test`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/agent/server.ts
git commit -m "$(cat <<'EOF'
feat: pass OAuth flag when building container labels

Static sites with OAuth now get the forwardAuth middleware label
so Traefik will call /auth/check before allowing access.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Delete fileserver.ts

Now that static sites are served by nginx containers, we can delete the custom fileserver.

**Files:**
- Delete: `src/lib/agent/fileserver.ts`
- Modify: `src/lib/agent/server.ts` (remove import and usage)

**Step 1: Remove usage in server.ts**

Update `src/lib/agent/server.ts`:

1. Remove the import:
```typescript
// DELETE: import { createFileServerHandler } from "./fileserver.ts"
```

2. Remove the property:
```typescript
// DELETE: private fileServerHandler: (req: Request) => Promise<Response | null>
```

3. Remove from constructor:
```typescript
// DELETE: this.fileServerHandler = createFileServerHandler(this.storage, config.domain, this.groups)
```

4. Update handleRequest to not call fileserver:
```typescript
private async handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const host = req.headers.get("host") || ""
  const hostWithoutPort = host.split(":")[0]

  // Check if this is an API request
  const isApiRequest = hostWithoutPort === `api.${this.config.domain}` ||
    hostWithoutPort === "localhost" ||
    hostWithoutPort === "127.0.0.1"

  if (!isApiRequest) {
    // Non-API requests are handled by nginx containers via Traefik
    // In test mode (skipTraefik), return 404
    return this.error("Not found - requests should go through Traefik", 404)
  }

  // ... rest of API routing ...
}
```

**Step 2: Delete fileserver.ts**

```bash
rm src/lib/agent/fileserver.ts
```

**Step 3: Run tests to verify nothing breaks**

Run: `bun test`
Expected: PASS (tests should still pass)

**Step 4: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor: delete fileserver.ts

Static files are now served by nginx containers, so the custom
fileserver is no longer needed. Non-API requests in test mode
now return 404 (in production, Traefik routes to containers).

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Update handleUpdateAuth to Sync App Record

When site auth is updated, also update the App record.

**Files:**
- Modify: `src/lib/agent/server.ts` (handleUpdateAuth)

**Step 1: Write the failing test**

Add to `src/__tests__/sites-as-containers.test.ts`:

```typescript
it("syncs OAuth changes to app record", async () => {
  const zipData = createTestZip()

  // Deploy without OAuth
  await fetch(`${baseUrl}/sites/authsync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/zip",
      "X-API-Key": TEST_API_KEY,
    },
    body: zipData,
  })

  // Add OAuth
  await fetch(`${baseUrl}/sites/authsync/auth`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": TEST_API_KEY,
    },
    body: JSON.stringify({
      allowedEmails: ["new@example.com"],
    }),
  })

  // Check app has OAuth
  const appRes = await fetch(`${baseUrl}/apps/authsync`, {
    headers: { "X-API-Key": TEST_API_KEY },
  })
  const { data: app } = await appRes.json()
  expect(app.oauth?.allowedEmails).toContain("new@example.com")
})

it("removes OAuth from app record when removed from site", async () => {
  const zipData = createTestZip()

  // Deploy with OAuth
  await fetch(`${baseUrl}/sites/authremove`, {
    method: "POST",
    headers: {
      "Content-Type": "application/zip",
      "X-API-Key": TEST_API_KEY,
      "X-Site-OAuth-Emails": "user@example.com",
    },
    body: zipData,
  })

  // Remove OAuth
  await fetch(`${baseUrl}/sites/authremove/auth`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": TEST_API_KEY,
    },
    body: JSON.stringify({ remove: true }),
  })

  // Check app has no OAuth
  const appRes = await fetch(`${baseUrl}/apps/authremove`, {
    headers: { "X-API-Key": TEST_API_KEY },
  })
  const { data: app } = await appRes.json()
  expect(app.oauth).toBeUndefined()
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/sites-as-containers.test.ts`
Expected: FAIL (app OAuth not synced)

**Step 3: Write the implementation**

Update `handleUpdateAuth` in `src/lib/agent/server.ts`:

```typescript
private async handleUpdateAuth(subdomain: string, req: Request): Promise<Response> {
  if (!this.storage.siteExists(subdomain)) {
    return this.error("Site not found", 404)
  }

  try {
    const body = (await req.json()) as {
      allowedEmails?: string[]
      allowedDomain?: string
      allowedGroups?: string[]
      remove?: boolean
    }

    let oauth: SiteOAuth | null = null

    if (body.remove) {
      oauth = null
    } else if (body.allowedEmails || body.allowedDomain || body.allowedGroups) {
      if (!this.hasOAuthEnabled()) {
        return this.error(
          "Google authentication not configured. Run 'siteio agent oauth' on the server to enable it.",
          400
        )
      }

      oauth = {}
      if (body.allowedEmails) {
        oauth.allowedEmails = body.allowedEmails.map((e) => e.toLowerCase())
      }
      if (body.allowedDomain) {
        oauth.allowedDomain = body.allowedDomain.toLowerCase()
      }
      if (body.allowedGroups) {
        oauth.allowedGroups = body.allowedGroups.map((g) => g.toLowerCase())
      }
    } else {
      return this.error("Provide allowedEmails, allowedDomain, or allowedGroups, or set remove: true")
    }

    // Update site metadata
    const updated = this.storage.updateOAuth(subdomain, oauth)
    if (!updated) {
      return this.error("Failed to update authentication", 500)
    }

    // Sync to app record if exists
    if (this.appStorage.exists(subdomain)) {
      this.appStorage.update(subdomain, { oauth: oauth || undefined })

      // Redeploy container to update labels (if Docker available)
      if (this.docker.isAvailable() && this.docker.containerExists(subdomain)) {
        const app = this.appStorage.get(subdomain)!
        const sitePath = this.storage.getSitePath(subdomain)
        const domain = `${subdomain}.${this.config.domain}`

        // Remove old container
        await this.docker.remove(subdomain)

        // Run new container with updated labels
        const labels = this.docker.buildTraefikLabels(subdomain, [domain], 80, !!oauth)
        const containerId = await this.docker.run({
          name: subdomain,
          image: "nginx:alpine",
          internalPort: 80,
          env: {},
          volumes: [{ name: sitePath, mountPath: "/usr/share/nginx/html", readonly: true }],
          restartPolicy: "unless-stopped",
          network: "siteio-network",
          labels,
        })

        this.appStorage.update(subdomain, {
          containerId,
          deployedAt: new Date().toISOString(),
        })
      }
    }

    // Update Traefik config
    const allSites = this.storage.listSites()
    this.traefik?.updateDynamicConfig(allSites)

    return this.json(null)
  } catch (err) {
    return this.error("Invalid request body")
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/sites-as-containers.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/agent/server.ts src/__tests__/sites-as-containers.test.ts
git commit -m "$(cat <<'EOF'
feat: sync OAuth changes to app record and container

When updating site OAuth settings, also:
1. Update the App record
2. Redeploy container with updated Traefik labels

This ensures forwardAuth middleware is added/removed correctly.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Update Existing Tests

Some existing tests may need updates due to the changes. Run all tests and fix any failures.

**Files:**
- Modify: Various test files as needed

**Step 1: Run all tests**

```bash
bun test
```

**Step 2: Fix any failures**

Common fixes might include:
- Updating mock data to include new fields
- Adjusting expectations for changed behavior
- Adding missing test data directories

**Step 3: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
test: update existing tests for Phase 2 changes

Fix tests affected by static sites as containers changes.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Add Index Export for AppStorage Methods

Export the new createStaticSiteApp method if needed for external use.

**Files:**
- Modify: `src/index.ts` (if needed)

**Step 1: Check current exports**

Read `src/index.ts` to see what's currently exported.

**Step 2: Add exports if needed**

The AppStorage class is already exported, so createStaticSiteApp should be available.

**Step 3: Commit (if changes made)**

```bash
git add src/index.ts
git commit -m "$(cat <<'EOF'
chore: update exports for Phase 2

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Final Integration Test

Run full integration test to ensure everything works end-to-end.

**Files:**
- None (just testing)

**Step 1: Run all tests**

```bash
bun test
```

**Step 2: Run type check**

```bash
bun run typecheck
```

**Step 3: Verify no issues**

All tests should pass and no type errors.

**Step 4: Final commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat: complete Phase 2 - Static Sites as Containers

Phase 2 implementation complete:
- Static sites now run as nginx:alpine containers
- /auth/check endpoint for Traefik forwardAuth
- fileserver.ts deleted (nginx serves files)
- Traefik uses Docker provider for container discovery
- OAuth changes sync to app records and containers

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Summary

After completing all tasks:

1. **New endpoint**: `GET /auth/check` - Traefik forwardAuth for OAuth
2. **Updated storage**: AppStorage.create accepts OAuth, new createStaticSiteApp helper
3. **Updated deployment**: handleDeploy creates nginx container for static sites
4. **Updated undeploy**: handleUndeploy removes container and app record
5. **Updated auth**: handleUpdateAuth syncs to app record and redeploys container
6. **Traefik changes**: Docker provider enabled, forwardAuth middleware added
7. **Deleted**: fileserver.ts (nginx now serves static files)

The CLI commands (`siteio sites deploy`, `siteio sites list`, etc.) continue to work unchanged, but internally static sites now run as containers.
