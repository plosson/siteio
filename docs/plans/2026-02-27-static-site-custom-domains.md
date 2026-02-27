# Custom Domains for Static Sites — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow static sites to have additional custom domains (e.g., `mycoolsite.com`) alongside their default `<subdomain>.<base-domain>` URL.

**Architecture:** Add `domains?: string[]` to site metadata. Extend nginx config with per-domain server blocks. Add Traefik routers for each custom domain. Expose via new `PATCH /sites/:subdomain/domains` API endpoint and `siteio sites set` CLI command.

**Tech Stack:** Bun, TypeScript, Traefik, nginx, Commander.js

---

### Task 1: Add `domains` field to types

**Files:**
- Modify: `src/types.ts:169-176` (SiteMetadata)
- Modify: `src/types.ts:122-129` (SiteInfo)

**Step 1: Add `domains` to `SiteMetadata`**

In `src/types.ts`, add `domains?: string[]` to the `SiteMetadata` interface:

```typescript
export interface SiteMetadata {
  subdomain: string
  domains?: string[]
  size: number
  deployedAt: string
  deployedBy?: string
  files: string[]
  oauth?: SiteOAuth
}
```

**Step 2: Add `domains` to `SiteInfo`**

In `src/types.ts`, add `domains?: string[]` to the `SiteInfo` interface:

```typescript
export interface SiteInfo {
  subdomain: string
  url: string
  domains?: string[]
  size: number
  deployedAt: string
  oauth?: SiteOAuth
  tls?: TlsStatus
}
```

**Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS (no consumers of these fields yet)

**Step 4: Run tests**

Run: `bun test`
Expected: All tests pass (backward-compatible addition)

**Step 5: Commit**

```bash
git add src/types.ts
git commit -m "feat: add domains field to SiteMetadata and SiteInfo types"
```

---

### Task 2: Preserve domains in SiteStorage on redeploy

**Files:**
- Modify: `src/lib/agent/storage.ts:104-158` (extractAndStore method)

**Step 1: Write the failing test**

Add to `src/__tests__/api/sites.test.ts`, inside the `Sites API` describe block, after the "should redeploy and replace existing site" test:

```typescript
test("should preserve domains on redeploy", async () => {
  // Deploy a site
  const files = { "index.html": new TextEncoder().encode("<html>v1</html>") }
  const zipData = zipSync(files, { level: 6 })
  await fetch(`http://localhost:${TEST_PORT}/sites/domain-test`, {
    method: "POST",
    headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/zip" },
    body: zipData,
  })

  // Set domains via the domains endpoint
  await fetch(`http://localhost:${TEST_PORT}/sites/domain-test/domains`, {
    method: "PATCH",
    headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ domains: ["mycoolsite.com"] }),
  })

  // Redeploy
  const files2 = { "index.html": new TextEncoder().encode("<html>v2</html>") }
  const zipData2 = zipSync(files2, { level: 6 })
  const response = await fetch(`http://localhost:${TEST_PORT}/sites/domain-test`, {
    method: "POST",
    headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/zip" },
    body: zipData2,
  })

  const data = await parseJson<SiteInfo>(response)
  expect(data.data?.domains).toEqual(["mycoolsite.com"])

  // Cleanup
  await fetch(`http://localhost:${TEST_PORT}/sites/domain-test`, {
    method: "DELETE",
    headers: { "X-API-Key": TEST_API_KEY },
  })
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/api/sites.test.ts`
Expected: FAIL (domains endpoint doesn't exist yet, and storage doesn't preserve domains)

**Step 3: Update `extractAndStore` to preserve existing domains**

In `src/lib/agent/storage.ts`, modify `extractAndStore` to carry over the `domains` field from the existing metadata:

```typescript
async extractAndStore(
  subdomain: string,
  zipData: Uint8Array,
  oauth?: SiteOAuth,
  deployedBy?: string
): Promise<SiteMetadata> {
  const sitePath = this.getSitePath(subdomain)

  // Read existing metadata to preserve domains
  const existingMetadata = this.getMetadata(subdomain)

  // Archive existing site before overwriting
  if (existsSync(sitePath)) {
    this.archiveCurrentVersion(subdomain)
    rmSync(sitePath, { recursive: true })
  }

  // ... (zip extraction stays the same) ...

  // Save metadata — preserve existing domains
  const metadata: SiteMetadata = {
    subdomain,
    domains: existingMetadata?.domains,
    size: totalSize,
    deployedAt: new Date().toISOString(),
    deployedBy,
    files,
    oauth,
  }

  writeFileSync(this.getMetadataPath(subdomain), JSON.stringify(metadata, null, 2))
  return metadata
}
```

**Step 4: Add `updateDomains` method to `SiteStorage`**

In `src/lib/agent/storage.ts`, add:

```typescript
updateDomains(subdomain: string, domains: string[]): boolean {
  const metadata = this.getMetadata(subdomain)
  if (!metadata) {
    return false
  }

  metadata.domains = domains.length > 0 ? domains : undefined
  writeFileSync(this.getMetadataPath(subdomain), JSON.stringify(metadata, null, 2))
  return true
}
```

**Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add src/lib/agent/storage.ts
git commit -m "feat: add updateDomains method and preserve domains on redeploy"
```

---

### Task 3: Add PATCH /sites/:subdomain/domains API endpoint

**Files:**
- Modify: `src/lib/agent/server.ts` (add route handler + domain validation)

**Step 1: Write the failing test**

Add to `src/__tests__/api/sites.test.ts`, a new describe block after `Site OAuth API`:

```typescript
describe("Site Domains API", () => {
  const subdomain = "domains-test"

  beforeEach(async () => {
    // Deploy a site
    const files = { "index.html": new TextEncoder().encode("<html>test</html>") }
    const zipData = zipSync(files, { level: 6 })
    await fetch(`http://localhost:${TEST_PORT}/sites/${subdomain}`, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/zip" },
      body: zipData,
    })
  })

  afterEach(async () => {
    await fetch(`http://localhost:${TEST_PORT}/sites/${subdomain}`, {
      method: "DELETE",
      headers: { "X-API-Key": TEST_API_KEY },
    })
  })

  test("should set custom domains", async () => {
    const response = await fetch(`http://localhost:${TEST_PORT}/sites/${subdomain}/domains`, {
      method: "PATCH",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ domains: ["mycoolsite.com", "www.mycoolsite.com"] }),
    })

    expect(response.ok).toBe(true)
    const data = await parseJson<SiteInfo>(response)
    expect(data.data?.domains).toEqual(["mycoolsite.com", "www.mycoolsite.com"])
  })

  test("should include domains in site listing", async () => {
    // Set domains
    await fetch(`http://localhost:${TEST_PORT}/sites/${subdomain}/domains`, {
      method: "PATCH",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ domains: ["example.org"] }),
    })

    // List sites
    const response = await fetch(`http://localhost:${TEST_PORT}/sites`, {
      headers: { "X-API-Key": TEST_API_KEY },
    })
    const data = await parseJson<SiteInfo[]>(response)
    const site = data.data?.find(s => s.subdomain === subdomain)
    expect(site?.domains).toEqual(["example.org"])
  })

  test("should clear domains with empty array", async () => {
    // Set then clear
    await fetch(`http://localhost:${TEST_PORT}/sites/${subdomain}/domains`, {
      method: "PATCH",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ domains: ["example.org"] }),
    })

    const response = await fetch(`http://localhost:${TEST_PORT}/sites/${subdomain}/domains`, {
      method: "PATCH",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ domains: [] }),
    })

    expect(response.ok).toBe(true)
    const data = await parseJson<SiteInfo>(response)
    expect(data.data?.domains).toBeUndefined()
  })

  test("should return 404 for non-existent site", async () => {
    const response = await fetch(`http://localhost:${TEST_PORT}/sites/nonexistent/domains`, {
      method: "PATCH",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ domains: ["example.org"] }),
    })
    expect(response.status).toBe(404)
  })

  test("should reject invalid domain format", async () => {
    const response = await fetch(`http://localhost:${TEST_PORT}/sites/${subdomain}/domains`, {
      method: "PATCH",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ domains: ["not a domain!"] }),
    })
    expect(response.status).toBe(400)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/api/sites.test.ts`
Expected: FAIL (endpoint doesn't exist)

**Step 3: Add route handler to server.ts**

In `src/lib/agent/server.ts`, add route matching in `handleRequest` (after the auth match block around line 138):

```typescript
// PATCH /sites/:subdomain/domains - update site custom domains
const domainsMatch = path.match(/^\/sites\/([a-z0-9-]+)\/domains$/)
if (domainsMatch && req.method === "PATCH") {
  return this.handleUpdateDomains(domainsMatch[1]!, req)
}
```

Then add the handler method:

```typescript
private async handleUpdateDomains(subdomain: string, req: Request): Promise<Response> {
  if (!this.storage.siteExists(subdomain)) {
    return this.error("Site not found", 404)
  }

  try {
    const body = (await req.json()) as { domains?: string[] }

    if (!body.domains || !Array.isArray(body.domains)) {
      return this.error("'domains' array is required")
    }

    // Validate domain format
    const domainRegex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/
    for (const domain of body.domains) {
      if (!domainRegex.test(domain.toLowerCase())) {
        return this.error(`Invalid domain format: ${domain}`)
      }
    }

    // Check for conflicts with other sites
    const allSites = this.storage.listSites()
    for (const site of allSites) {
      if (site.subdomain === subdomain) continue
      if (site.domains) {
        const overlap = body.domains.filter(d => site.domains!.includes(d))
        if (overlap.length > 0) {
          return this.error(`Domain(s) already in use by site '${site.subdomain}': ${overlap.join(", ")}`)
        }
      }
    }

    const updated = this.storage.updateDomains(subdomain, body.domains)
    if (!updated) {
      return this.error("Failed to update domains", 500)
    }

    // Update Traefik and nginx config
    const updatedSites = this.storage.listSites()
    this.traefik?.updateDynamicConfig(updatedSites)
    this.reloadNginx()

    const metadata = this.storage.getMetadata(subdomain)!
    const siteInfo: SiteInfo = {
      subdomain: metadata.subdomain,
      url: `https://${metadata.subdomain}.${this.config.domain}`,
      domains: metadata.domains,
      size: metadata.size,
      deployedAt: metadata.deployedAt,
      oauth: metadata.oauth,
    }

    return this.json(siteInfo)
  } catch (err) {
    return this.error("Invalid request body")
  }
}

private reloadNginx(): void {
  // Reload nginx config without restarting the container
  // Only works when Traefik is running (not in test mode)
  if (!this.config.skipTraefik) {
    const { spawnSync } = require("bun")
    spawnSync({ cmd: ["docker", "exec", "siteio-nginx", "nginx", "-s", "reload"], stdout: "pipe", stderr: "pipe" })
  }
}
```

**Step 4: Update `handleListSites` to include domains**

In `src/lib/agent/server.ts`, update the `handleListSites` method (around line 245):

```typescript
const siteInfos: SiteInfo[] = sites.map((site) => ({
  subdomain: site.subdomain,
  url: `https://${site.subdomain}.${this.config.domain}`,
  domains: site.domains,
  size: site.size,
  deployedAt: site.deployedAt,
  oauth: site.oauth,
  tls: tlsStatusMap.get(`site-${site.subdomain}`) || "pending",
}))
```

**Step 5: Update `handleDeploy` to include domains in response**

In `src/lib/agent/server.ts`, update the deploy response (around line 317):

```typescript
const siteInfo: SiteInfo = {
  subdomain: metadata.subdomain,
  url: `https://${metadata.subdomain}.${this.config.domain}`,
  domains: metadata.domains,
  size: metadata.size,
  deployedAt: metadata.deployedAt,
  oauth: metadata.oauth,
}
```

Similarly update `handleRollback` response (around line 461).

**Step 6: Run tests**

Run: `bun test src/__tests__/api/sites.test.ts`
Expected: All tests pass

**Step 7: Commit**

```bash
git add src/lib/agent/server.ts src/__tests__/api/sites.test.ts
git commit -m "feat: add PATCH /sites/:subdomain/domains API endpoint"
```

---

### Task 4: Generate nginx server blocks for custom domains

**Files:**
- Modify: `src/lib/agent/traefik.ts:73-106` (generateNginxConfig)

**Step 1: Write the failing test**

Add to `src/__tests__/unit/traefik-manager.test.ts`:

```typescript
it("generates nginx server blocks for sites with custom domains", () => {
  const traefik = new TraefikManager({
    dataDir: TEST_DATA_DIR,
    domain: "test.siteio.me",
    httpPort: 80,
    httpsPort: 443,
    fileServerPort: 3000,
  })

  traefik.updateNginxConfig([
    {
      subdomain: "my-blog",
      domains: ["mycoolsite.com", "www.mycoolsite.com"],
      size: 1024,
      deployedAt: "2024-01-01T00:00:00Z",
      files: ["index.html"],
    },
  ])

  // Read the generated nginx config
  const configPath = join(TEST_DATA_DIR, "nginx", "default.conf")
  const config = readFileSync(configPath, "utf-8")

  // Should contain the default regex catch-all
  expect(config).toContain("test\\.siteio\\.me")

  // Should contain server blocks for custom domains
  expect(config).toContain("server_name mycoolsite.com;")
  expect(config).toContain("server_name www.mycoolsite.com;")
  expect(config).toContain("root /sites/my-blog;")
})

it("does not generate extra server blocks for sites without custom domains", () => {
  const traefik = new TraefikManager({
    dataDir: TEST_DATA_DIR,
    domain: "test.siteio.me",
    httpPort: 80,
    httpsPort: 443,
    fileServerPort: 3000,
  })

  traefik.updateNginxConfig([
    {
      subdomain: "plain-site",
      size: 1024,
      deployedAt: "2024-01-01T00:00:00Z",
      files: ["index.html"],
    },
  ])

  const configPath = join(TEST_DATA_DIR, "nginx", "default.conf")
  const config = readFileSync(configPath, "utf-8")

  // Should only have the regex catch-all and default server
  expect(config).toContain("test\\.siteio\\.me")
  expect(config).not.toContain("server_name plain-site")
})
```

Add `import { readFileSync } from "fs"` to the test file imports if not already present.

**Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/unit/traefik-manager.test.ts`
Expected: FAIL (`updateNginxConfig` method doesn't exist)

**Step 3: Refactor nginx config generation to accept sites**

In `src/lib/agent/traefik.ts`:

1. Change `generateNginxConfig()` to accept a sites parameter:

```typescript
private generateNginxConfig(sites: SiteMetadata[] = []): string {
  const { domain } = this.config
  const escapedDomain = domain.replace(/\./g, "\\.")

  let config = `
server {
    listen 80;
    server_name ~^(?<subdomain>[a-z0-9-]+)\\.${escapedDomain}$;

    root /sites/$subdomain;
    index index.html index.htm;

    location / {
        try_files $uri $uri/ /index.html;
    }

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;
}
`

  // Add explicit server blocks for each custom domain
  for (const site of sites) {
    if (!site.domains || site.domains.length === 0) continue
    for (const customDomain of site.domains) {
      config += `
server {
    listen 80;
    server_name ${customDomain};

    root /sites/${site.subdomain};
    index index.html index.htm;

    location / {
        try_files $uri $uri/ /index.html;
    }

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;
}
`
    }
  }

  config += `
server {
    listen 80 default_server;
    return 404;
}
`
  return config.trim()
}
```

2. Update `writeNginxConfig` to accept sites and make it public as `updateNginxConfig`:

```typescript
updateNginxConfig(sites: SiteMetadata[] = []): void {
  const configPath = join(this.nginxConfigDir, "default.conf")
  writeFileSync(configPath, this.generateNginxConfig(sites))
}
```

3. Update the constructor call from `this.writeNginxConfig()` to `this.updateNginxConfig()`.

**Step 4: Run tests**

Run: `bun test src/__tests__/unit/traefik-manager.test.ts`
Expected: All tests pass

**Step 5: Run all tests**

Run: `bun test`
Expected: All tests pass

**Step 6: Commit**

```bash
git add src/lib/agent/traefik.ts src/__tests__/unit/traefik-manager.test.ts
git commit -m "feat: generate nginx server blocks for custom domains"
```

---

### Task 5: Generate Traefik routers for custom domains

**Files:**
- Modify: `src/lib/agent/traefik.ts:227-367` (generateDynamicConfig)

**Step 1: Write the failing test**

Add to `src/__tests__/unit/traefik-manager.test.ts`:

```typescript
it("generates Traefik routers for custom domains", () => {
  const traefik = new TraefikManager({
    dataDir: TEST_DATA_DIR,
    domain: "test.siteio.me",
    httpPort: 80,
    httpsPort: 443,
    fileServerPort: 3000,
  })

  const dynamicConfig = traefik.generateDynamicConfig([
    {
      subdomain: "my-blog",
      domains: ["mycoolsite.com", "www.mycoolsite.com"],
      size: 1024,
      deployedAt: "2024-01-01T00:00:00Z",
      files: ["index.html"],
    },
  ])

  // Should have the standard subdomain router
  expect(dynamicConfig).toContain("site-my-blog")
  expect(dynamicConfig).toContain("my-blog.test.siteio.me")

  // Should have routers for custom domains
  expect(dynamicConfig).toContain("site-my-blog-cd-0")
  expect(dynamicConfig).toContain("mycoolsite.com")
  expect(dynamicConfig).toContain("site-my-blog-cd-1")
  expect(dynamicConfig).toContain("www.mycoolsite.com")
})

it("applies OAuth middlewares to custom domain routers", () => {
  const traefik = new TraefikManager({
    dataDir: TEST_DATA_DIR,
    domain: "test.siteio.me",
    httpPort: 80,
    httpsPort: 443,
    fileServerPort: 3000,
    oauthConfig: {
      issuerUrl: "https://auth.example.com",
      clientId: "test-client",
      clientSecret: "test-secret",
      cookieSecret: "test-cookie-secret",
      cookieDomain: "test.siteio.me",
    },
  })

  const dynamicConfig = traefik.generateDynamicConfig([
    {
      subdomain: "protected",
      domains: ["secure.example.org"],
      size: 1024,
      deployedAt: "2024-01-01T00:00:00Z",
      files: ["index.html"],
      oauth: { allowedEmails: ["user@example.com"] },
    },
  ])

  // Custom domain router should exist
  expect(dynamicConfig).toContain("site-protected-cd-0")
  expect(dynamicConfig).toContain("secure.example.org")

  // OAuth middlewares should be defined
  expect(dynamicConfig).toContain("oauth2-proxy-auth")
  expect(dynamicConfig).toContain("siteio-authz")
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/unit/traefik-manager.test.ts`
Expected: FAIL (no custom domain routers generated)

**Step 3: Add custom domain routers in generateDynamicConfig**

In `src/lib/agent/traefik.ts`, inside the `for (const site of sites)` loop (around line 328), after adding the subdomain router, add:

```typescript
// Add routers for custom domains
if (site.domains) {
  for (let i = 0; i < site.domains.length; i++) {
    const customDomain = site.domains[i]!
    const cdRouterName = `site-${site.subdomain}-cd-${i}`
    const cdRouter: Record<string, unknown> = {
      rule: `Host(\`${customDomain}\`)`,
      entryPoints: ["websecure"],
      service: "nginx-service",
      tls: {
        certResolver: "letsencrypt",
      },
    }

    // Apply same OAuth middlewares as subdomain router
    if (oauthConfig && site.oauth) {
      const hasRestrictions =
        (site.oauth.allowedEmails && site.oauth.allowedEmails.length > 0) ||
        site.oauth.allowedDomain ||
        (site.oauth.allowedGroups && site.oauth.allowedGroups.length > 0)

      if (hasRestrictions) {
        cdRouter.middlewares = ["oauth-errors", "oauth2-proxy-auth", "siteio-authz"]
      }
    }

    routers[cdRouterName] = cdRouter
  }
}
```

**Step 4: Run tests**

Run: `bun test src/__tests__/unit/traefik-manager.test.ts`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/lib/agent/traefik.ts src/__tests__/unit/traefik-manager.test.ts
git commit -m "feat: generate Traefik routers for site custom domains"
```

---

### Task 6: Wire nginx reload into server when domains/deploys change

**Files:**
- Modify: `src/lib/agent/server.ts` (update deploy/undeploy/rollback to rebuild nginx config)
- Modify: `src/lib/agent/traefik.ts` (expose `reloadNginx` method)

**Step 1: Add `reloadNginx` method to TraefikManager**

In `src/lib/agent/traefik.ts`, add:

```typescript
reloadNginx(): void {
  spawnSync({
    cmd: ["docker", "exec", NGINX_CONTAINER_NAME, "nginx", "-s", "reload"],
    stdout: "pipe",
    stderr: "pipe",
  })
}
```

**Step 2: Update server.ts to pass sites to nginx config updates**

Wherever `this.traefik?.updateDynamicConfig(allSites)` is called in `server.ts`, also update nginx config and reload. Create a helper:

```typescript
private updateRoutingConfig(sites: SiteMetadata[]): void {
  if (this.traefik) {
    this.traefik.updateDynamicConfig(sites)
    this.traefik.updateNginxConfig(sites)
    this.traefik.reloadNginx()
  }
}
```

Then replace all `this.traefik?.updateDynamicConfig(allSites)` calls with `this.updateRoutingConfig(allSites)`. This covers: deploy, undeploy, updateAuth, rollback, and updateDomains.

Also update `start()` to pass existing sites to nginx config:

```typescript
async start(): Promise<void> {
  if (this.traefik) {
    await this.traefik.start()
    const existingSites = this.storage.listSites()
    this.traefik.updateDynamicConfig(existingSites)
    this.traefik.updateNginxConfig(existingSites)
  }
  // ... rest unchanged
}
```

**Step 3: Remove the standalone `reloadNginx` method from server.ts**

The nginx reload is now handled inside `updateRoutingConfig` via `TraefikManager.reloadNginx()`.

**Step 4: Run tests**

Run: `bun test`
Expected: All tests pass (skipTraefik=true in tests, so traefik is null — no nginx calls)

**Step 5: Commit**

```bash
git add src/lib/agent/server.ts src/lib/agent/traefik.ts
git commit -m "feat: wire nginx config rebuild on site domain/deploy changes"
```

---

### Task 7: Update auth check for custom domains

**Files:**
- Modify: `src/lib/agent/server.ts:956-1009` (handleAuthCheck)

**Step 1: Write the failing test**

Add to `src/__tests__/api/auth.test.ts` (read the file first to understand its test pattern, then add a test for custom domain auth check):

```typescript
test("should look up OAuth config for custom domain", async () => {
  // Deploy a site with OAuth
  const files = { "index.html": new TextEncoder().encode("<html>auth test</html>") }
  const zipData = zipSync(files, { level: 6 })
  await fetch(`http://localhost:${TEST_PORT}/sites/auth-custom`, {
    method: "POST",
    headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/zip" },
    body: zipData,
  })

  // Set custom domain
  await fetch(`http://localhost:${TEST_PORT}/sites/auth-custom/domains`, {
    method: "PATCH",
    headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ domains: ["custom.example.org"] }),
  })

  // Auth check for custom domain — no OAuth set, should pass
  const response = await fetch(`http://localhost:${TEST_PORT}/auth/check`, {
    headers: { host: "custom.example.org" },
  })
  expect(response.status).toBe(200)

  // Cleanup
  await fetch(`http://localhost:${TEST_PORT}/sites/auth-custom`, {
    method: "DELETE",
    headers: { "X-API-Key": TEST_API_KEY },
  })
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/api/auth.test.ts`
Expected: FAIL (custom domain doesn't match the base domain suffix check, falls through to passthrough)

Note: This test might actually pass by accident since non-matching hosts currently return 200. The real test is when OAuth IS configured — add that scenario if the auth test file supports OAuth setup.

**Step 3: Update handleAuthCheck to look up sites by custom domain**

In `src/lib/agent/server.ts`, modify `handleAuthCheck`:

```typescript
private handleAuthCheck(req: Request): Response {
  const host = req.headers.get("host") || req.headers.get("x-forwarded-host") || ""
  const hostWithoutPort = host.split(":")[0] || ""

  const domainSuffix = `.${this.config.domain}`

  let oauth: SiteOAuth | undefined

  if (hostWithoutPort.endsWith(domainSuffix)) {
    // Standard subdomain match
    const subdomain = hostWithoutPort.slice(0, -domainSuffix.length)
    if (!subdomain || subdomain === "api") {
      return new Response(null, { status: 200 })
    }

    // Look up OAuth config from app or site
    const app = this.appStorage.get(subdomain)
    if (app) {
      oauth = app.oauth
    } else {
      const site = this.storage.getMetadata(subdomain)
      if (site) {
        oauth = site.oauth
      }
    }
  } else {
    // Custom domain — reverse lookup across sites
    const allSites = this.storage.listSites()
    const matchingSite = allSites.find(s => s.domains?.includes(hostWithoutPort))
    if (matchingSite) {
      oauth = matchingSite.oauth
    }
    // Also check apps (they already support custom domains)
    if (!oauth) {
      const allApps = this.appStorage.list()
      const matchingApp = allApps.find(a => a.domains.includes(hostWithoutPort))
      if (matchingApp) {
        oauth = matchingApp.oauth
      }
    }
  }

  // No OAuth configured (or resource not found), allow access
  if (!oauth) {
    return new Response(null, { status: 200 })
  }

  // ... rest of the method stays the same (email check, authorization) ...
}
```

**Step 4: Run tests**

Run: `bun test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/lib/agent/server.ts src/__tests__/api/auth.test.ts
git commit -m "feat: support custom domain lookup in auth check"
```

---

### Task 8: Add client method and CLI command

**Files:**
- Modify: `src/lib/client.ts` (add `updateSiteDomains` method)
- Create: `src/commands/sites/set.ts`
- Modify: `src/cli.ts` (register `sites set` command)

**Step 1: Add `updateSiteDomains` to SiteioClient**

In `src/lib/client.ts`, add after `updateSiteOAuth`:

```typescript
async updateSiteDomains(subdomain: string, domains: string[]): Promise<SiteInfo> {
  const response = await this.request<ApiResponse<SiteInfo>>(
    "PATCH",
    `/sites/${subdomain}/domains`,
    JSON.stringify({ domains }),
    { "Content-Type": "application/json" }
  )
  if (!response.data) {
    throw new ApiError("Invalid response from server")
  }
  return response.data
}
```

**Step 2: Create `src/commands/sites/set.ts`**

```typescript
import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { formatSuccess } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

export interface SetSiteOptions {
  domain?: string[]
  json?: boolean
}

export async function setSiteCommand(
  subdomain: string,
  options: SetSiteOptions = {}
): Promise<void> {
  const spinner = ora()

  try {
    if (!subdomain) {
      throw new ValidationError("Subdomain is required")
    }

    const client = new SiteioClient()

    if (!options.domain || options.domain.length === 0) {
      throw new ValidationError("No updates specified. Use --domain to set custom domains.")
    }

    spinner.start(`Updating site ${subdomain}`)
    const site = await client.updateSiteDomains(subdomain, options.domain)
    spinner.succeed(`Updated site ${subdomain}`)

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: site }, null, 2))
    } else {
      console.log("")
      console.log(formatSuccess(`Site ${chalk.bold(subdomain)} updated.`))
      console.log("")
      if (site.domains && site.domains.length > 0) {
        console.log(chalk.bold("Custom domains:"))
        for (const d of site.domains) {
          console.log(`  ${chalk.cyan(d)}`)
        }
      } else {
        console.log(chalk.dim("No custom domains set."))
      }
      console.log("")
    }
    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
```

**Step 3: Register in CLI**

In `src/cli.ts`, add after the `sites auth` command (around line 172):

```typescript
sites
  .command("set <subdomain>")
  .description("Update site configuration")
  .option("-d, --domain <domain>", "Set custom domains (repeatable)", (val: string, prev: string[]) => {
    prev = prev || []
    prev.push(val)
    return prev
  }, [])
  .action(async (subdomain, options) => {
    const { setSiteCommand } = await import("./commands/sites/set.ts")
    await setSiteCommand(subdomain, { ...options, json: program.opts().json })
  })
```

**Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/client.ts src/commands/sites/set.ts src/cli.ts
git commit -m "feat: add siteio sites set command for custom domains"
```

---

### Task 9: Display domains in list and info commands

**Files:**
- Modify: `src/commands/sites/list.ts`
- Modify: `src/commands/sites/info.ts`

**Step 1: Update `sites info` to show domains**

In `src/commands/sites/info.ts`, add after the URL line (around line 31):

```typescript
console.log(`  URL:      ${chalk.cyan(site.url)}`)
if (site.domains && site.domains.length > 0) {
  console.log(`  Domains:`)
  for (const d of site.domains) {
    console.log(`            ${chalk.cyan(`https://${d}`)}`)
  }
}
```

**Step 2: Update `sites list` to show domain count**

In `src/commands/sites/list.ts`, add a DOMAINS column to the table. Update the headers and rows:

```typescript
const headers = ["SUBDOMAIN", "URL", "SIZE", "TLS", "DOMAINS", "AUTH", "DEPLOYED"]
const rows = sites.map((site) => {
  const date = new Date(site.deployedAt)
  const dateStr = date.toLocaleDateString() + " " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  const authStr = site.oauth ? chalk.yellow("oauth") : chalk.dim("-")
  const domainsStr = site.domains && site.domains.length > 0
    ? chalk.cyan(`${site.domains.length}`)
    : chalk.dim("-")
  const tlsStr =
    site.tls === "valid"
      ? chalk.green("✓")
      : site.tls === "pending"
        ? chalk.yellow("…")
        : site.tls === "error"
          ? chalk.red("✗")
          : chalk.dim("-")
  return [site.subdomain, site.url, formatBytes(site.size), tlsStr, domainsStr, authStr, dateStr]
})
```

**Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add src/commands/sites/list.ts src/commands/sites/info.ts
git commit -m "feat: display custom domains in sites list and info commands"
```

---

### Task 10: Final integration test and cleanup

**Step 1: Run full test suite**

Run: `bun test`
Expected: All tests pass

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 3: Manual smoke test**

Run: `bun run start sites set --help`
Expected: Shows help with `--domain` option

**Step 4: Commit any remaining changes**

```bash
git status
# Stage any remaining files
git add -A
git commit -m "feat: custom domains for static sites — complete implementation"
```

---

Plan complete and saved to `docs/plans/2026-02-27-static-site-custom-domains.md`. Two execution options:

**1. Subagent-Driven (this session)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** — Open new session in a worktree, batch execution with checkpoints

Which approach?
