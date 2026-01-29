# Siteio Evolution: Adding Docker Container Support

**Goal:** Extend siteio to deploy Docker containers alongside static sites.

**Date:** 2026-01-29

---

## Overview

Siteio is a simple, effective tool for deploying static sites. Users love:
- Single command deploys: `siteio sites deploy ./dist -s mysite`
- Automatic HTTPS via Traefik
- Simple JSON-based state (no database)
- Single-process architecture

This document describes how to extend siteio to **also deploy Docker containers**, using the same patterns that make static site deployment simple.

---

## What Siteio Does Today

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        SITEIO AGENT                              │
│                                                                  │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐ │
│  │  Bun HTTP   │    │   Site      │    │   Traefik           │ │
│  │  Server     │───▶│   Storage   │    │   Manager           │ │
│  │  (port 3000)│    │   (files)   │    │   (docker container)│ │
│  └──────┬──────┘    └─────────────┘    └─────────────────────┘ │
│         │                                        │               │
│         │           ┌─────────────┐              │               │
│         └──────────▶│ File Server │◀─────────────┘               │
│                     │ (serves     │   routes requests            │
│                     │  static     │   to fileserver              │
│                     │  files)     │                              │
│                     └─────────────┘                              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         TRAEFIK                                  │
│  - Listens on ports 80/443                                       │
│  - Terminates TLS (Let's Encrypt HTTP-01)                        │
│  - Routes *.domain to fileserver via host.docker.internal        │
│  - Routes api.domain to API server                               │
└─────────────────────────────────────────────────────────────────┘
```

### Deploy Flow

```
1. Client: siteio sites deploy ./dist --subdomain mysite
2. Client zips folder, sends to: POST /sites/mysite (Content-Type: application/zip)
3. Agent extracts zip to: <dataDir>/sites/mysite/
4. Agent saves metadata to: <dataDir>/metadata/mysite.json
5. Agent updates Traefik dynamic.yml to route mysite.domain → fileserver
6. Traefik picks up config change, routes traffic
7. User visits https://mysite.example.com → served by fileserver
```

### Current File Structure

```
siteio/
├── src/
│   ├── cli.ts                    # CLI entry point (commander-based)
│   ├── index.ts                  # Library exports
│   ├── types.ts                  # TypeScript type definitions
│   ├── config/
│   │   ├── loader.ts             # Client config (~/.config/siteio/config.json)
│   │   └── oauth.ts              # OAuth configuration helpers
│   ├── commands/
│   │   ├── login.ts              # siteio login
│   │   ├── status.ts             # siteio status
│   │   ├── groups.ts             # siteio groups
│   │   ├── sites/
│   │   │   ├── deploy.ts         # Zips folder, uploads to agent
│   │   │   ├── list.ts           # Lists deployed sites
│   │   │   ├── undeploy.ts       # Removes a site
│   │   │   ├── download.ts       # Downloads site as zip
│   │   │   ├── auth.ts           # Configures OAuth for a site
│   │   │   └── info.ts           # Shows site details
│   │   └── agent/
│   │       ├── start.ts          # Starts agent server
│   │       ├── stop.ts           # Stops agent
│   │       ├── restart.ts        # Restarts agent
│   │       ├── status.ts         # Shows agent status
│   │       ├── install.ts        # Installs as systemd service
│   │       └── oauth.ts          # Configures OAuth provider
│   ├── lib/
│   │   ├── client.ts             # SiteioClient - HTTP client for agent API
│   │   └── agent/
│   │       ├── server.ts         # AgentServer - Bun.serve HTTP server
│   │       ├── storage.ts        # SiteStorage - file extraction, metadata
│   │       ├── traefik.ts        # TraefikManager - config generation, container
│   │       ├── fileserver.ts     # Static file serving handler
│   │       └── groups.ts         # GroupStorage - email groups for OAuth
│   └── utils/
│       ├── errors.ts             # Error classes
│       ├── output.ts             # CLI output formatting
│       └── token.ts              # Token generation
├── package.json
└── tsconfig.json
```

### Data Directory

```
<dataDir>/                        # Default: /data
├── sites/
│   └── <subdomain>/              # Extracted static files
├── metadata/
│   └── <subdomain>.json          # Site metadata
├── groups/
│   └── groups.json               # Email groups for OAuth
├── traefik/
│   ├── traefik.yml               # Static Traefik config
│   └── dynamic.yml               # Dynamic routes (regenerated)
├── certs/
│   └── acme.json                 # Let's Encrypt certificates
└── oauth.json                    # OAuth provider config (optional)
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SITEIO_DOMAIN` | Yes | - | Base domain (e.g., `example.siteio.me`) |
| `SITEIO_API_KEY` | No | auto-generated | API key for authentication |
| `SITEIO_DATA_DIR` | No | `/data` | Data directory path |
| `SITEIO_HTTP_PORT` | No | `80` | Traefik HTTP port |
| `SITEIO_HTTPS_PORT` | No | `443` | Traefik HTTPS port |
| `SITEIO_EMAIL` | No | - | Email for Let's Encrypt |

### OAuth (Optional)

Sites can be protected with OAuth. The flow:

```
1. Admin configures OAuth: siteio agent oauth
2. Deploy with restrictions: siteio sites deploy ./dist -s mysite --allowed-emails alice@example.com
3. Requests go through oauth2-proxy for authentication
4. fileserver.ts checks if authenticated user is authorized for this site
```

---

## The Extension: Docker Containers

### What Users Want

Static sites are great, but users also want to deploy:
- Backend APIs (Node.js, Python, Go)
- Databases (Postgres, Redis)
- Full-stack apps built from Git repositories

They want the same simple experience:
```bash
siteio apps create myapi --image myregistry/myapi:latest
siteio apps deploy myapi
```

### Design Principle: Unify on Containers

Here's the insight: **if we're adding Docker container support, we can also run static sites as nginx containers**.

This gives us:
- One mental model: everything is a container
- Unified commands: `stop`, `restart`, `logs` work for all apps
- Simpler agent: no custom file server code
- Direct Traefik routing to containers

### New Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        SITEIO AGENT                              │
│                                                                  │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐ │
│  │  Bun HTTP   │    │   App       │    │   Docker            │ │
│  │  Server     │───▶│   Storage   │───▶│   Manager           │ │
│  │  (port 3000)│    │   (JSON)    │    │   (pull/run/stop)   │ │
│  └──────┬──────┘    └─────────────┘    └─────────────────────┘ │
│         │                                        │               │
│         │           ┌─────────────┐              │               │
│         └──────────▶│ /auth/check │              │               │
│                     │ (forwardAuth)│              │               │
│                     └─────────────┘              │               │
│                                                  │               │
│                     ┌─────────────┐              │               │
│                     │   Traefik   │◀─────────────┘               │
│                     │   Manager   │  updates config              │
│                     └─────────────┘                              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    DOCKER CONTAINERS                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │  Traefik    │  │  mysite     │  │  myapi      │             │
│  │  (router)   │  │  (nginx)    │  │  (user img) │             │
│  └─────────────┘  └─────────────┘  └─────────────┘             │
│         │               ▲               ▲                        │
│         └───────────────┴───────────────┘                        │
│              routes to containers directly                       │
└─────────────────────────────────────────────────────────────────┘
```

**What changes:**
- `DockerManager` handles container lifecycle (pull, run, stop, logs)
- `AppStorage` stores app metadata as JSON (replaces `SiteStorage` for metadata)
- Static sites run as nginx containers with volume-mounted files
- Traefik routes directly to containers (no `host.docker.internal`)
- `fileserver.ts` is deleted — nginx serves static files better anyway

---

## New Capabilities

### 1. Deploy Docker Images

```bash
# Create an app from a Docker image
siteio apps create myapi --image myregistry/myapi:latest --port 3000

# Add a domain
siteio apps set myapi -d myapi.example.com

# Deploy it
siteio apps deploy myapi

# View logs
siteio apps logs myapi
```

### 2. Deploy from Git Repositories

```bash
# Add git credentials (once)
siteio git-credentials add github --https -u myuser -t ghp_xxxx

# Create app from git
siteio apps create myapi --git https://github.com/user/repo --branch main

# Deploy (clones, builds, runs)
siteio apps deploy myapi
```

### 3. Configure Apps

```bash
# Environment variables
siteio apps set myapi -e DATABASE_URL=postgres://...
siteio apps set myapi -e REDIS_URL=redis://...

# Persistent volumes
siteio apps set myapi -v data:/app/data

# Restart policy
siteio apps set myapi --restart always
```

### 4. Static Sites (Unchanged CLI, New Implementation)

The `sites` commands work exactly as before:

```bash
siteio sites deploy ./dist -s mysite
siteio sites list
siteio sites undeploy mysite
```

But internally, static sites now run as nginx containers. This means:
- `siteio apps logs mysite` works (shows nginx access logs)
- `siteio apps stop mysite` works
- `siteio apps restart mysite` works

---

## Implementation

### Phase 1: Docker Container Support

Add the ability to deploy Docker images.

**New files:**

```
src/lib/agent/
├── docker.ts           # DockerManager class
├── app-storage.ts      # AppStorage class (JSON CRUD)
└── credentials.ts      # Registry and Git credentials

src/commands/apps/
├── create.ts
├── deploy.ts
├── stop.ts
├── restart.ts
├── rm.ts
├── list.ts
├── info.ts
├── set.ts
├── unset.ts
└── logs.ts
```

**DockerManager** handles:
```typescript
class DockerManager {
  async pull(image: string, credential?: RegistryCredential): Promise<void>
  async run(config: ContainerConfig): Promise<string>  // returns containerId
  async stop(containerId: string): Promise<void>
  async remove(containerId: string): Promise<void>
  async logs(containerId: string, tail?: number): Promise<string>
  async inspect(containerId: string): Promise<ContainerInfo | null>
}
```

**AppStorage** stores app metadata:
```typescript
class AppStorage {
  create(app: App): App
  get(name: string): App | null
  update(name: string, updates: Partial<App>): App | null
  delete(name: string): boolean
  list(): App[]
}
```

**App data model:**
```typescript
interface App {
  name: string
  type: "static" | "container"

  // Source
  image: string
  git?: {
    repoUrl: string
    branch: string
    dockerfile: string
    credentialId?: string
  }

  // Runtime
  env: Record<string, string>
  volumes: { name: string; mountPath: string }[]
  internalPort: number
  restartPolicy: "always" | "unless-stopped" | "on-failure" | "no"

  // Routing
  domains: string[]

  // OAuth (same as current sites)
  oauth?: {
    allowedEmails?: string[]
    allowedDomain?: string
    allowedGroups?: string[]
  }

  // State
  containerId?: string
  status: "pending" | "running" | "stopped" | "failed"
  deployedAt?: string
  createdAt: string
  updatedAt: string
}
```

### Phase 2: Static Sites as Containers

Convert static site deployment to use nginx containers.

**Changes:**

1. `POST /sites/:subdomain` now:
   - Extracts zip to `<dataDir>/sites/<name>/` (same as before)
   - Creates an App record with `type: "static"` and `image: "nginx:alpine"`
   - Runs nginx container with volume mount to the extracted files
   - Updates Traefik to route to the container

2. Delete `fileserver.ts` — no longer needed

3. Add `/auth/check` endpoint for OAuth authorization (see below)

**Static site as container:**
```bash
docker run -d \
  --name siteio-mysite \
  --network siteio-network \
  -v /data/sites/mysite:/usr/share/nginx/html:ro \
  -l traefik.enable=true \
  -l "traefik.http.routers.mysite.rule=Host(\`mysite.example.com\`)" \
  nginx:alpine
```

### Phase 3: Git Repository Builds

Add ability to build images from Git repositories.

**New file:** `src/lib/agent/git.ts`

```typescript
class GitManager {
  async clone(repoUrl: string, branch: string, targetDir: string, credential?: GitCredential): Promise<void>
  async build(contextDir: string, dockerfile: string, tag: string): Promise<void>
  cleanup(appName: string): void
}
```

**Deploy flow:**
```
1. Clone repo to /data/git/<appname>/
2. docker build -t siteio-<appname>:latest .
3. docker run ... siteio-<appname>:latest
4. Clean up /data/git/<appname>/
```

### Phase 4: Full Configuration

Add all configuration options.

**CLI:**
```bash
siteio apps set <name> -e KEY=value        # env var
siteio apps set <name> -v name:/path       # volume
siteio apps set <name> -d domain.com       # domain
siteio apps set <name> --port 8080         # internal port
siteio apps set <name> --restart always    # restart policy
siteio apps set <name> --command "npm start"
siteio apps set <name> --user 1000:1000

siteio apps unset <name> -e KEY
siteio apps unset <name> -d domain.com
```

---

## OAuth with Containers

### The Problem

Currently, `fileserver.ts` handles OAuth authorization — it checks if the authenticated user's email is allowed for a specific site. But nginx can't do this check.

### The Solution: Traefik forwardAuth

Traefik has a middleware called `forwardAuth` that calls an external service before forwarding requests. We use this to move the authorization check to the agent.

**New flow:**
```
User → Traefik → oauth2-proxy (authenticates)
                      ↓
              Sets X-Forwarded-Email header
                      ↓
              forwardAuth calls: GET /auth/check
                      ↓
              Agent checks: is this email allowed for this app?
                      ↓
              Returns 200 (yes) or 403 (no)
                      ↓
              If 200: Traefik forwards to nginx container
```

**New endpoint:** `GET /auth/check`

```typescript
// Called by Traefik, not by users
if (path === "/auth/check" && method === "GET") {
  const host = req.headers.get("Host")           // e.g., "mysite.example.com"
  const email = req.headers.get("X-Forwarded-Email")

  const subdomain = host.split(".")[0]           // "mysite"
  const app = this.appStorage.get(subdomain)

  if (!app?.oauth) {
    return new Response(null, { status: 200 })   // No OAuth = allow all
  }

  if (!email) {
    return new Response(null, { status: 401 })   // Not authenticated
  }

  const allowed = this.checkAuthorization(email, app.oauth)
  return new Response(null, { status: allowed ? 200 : 403 })
}
```

**Traefik config for OAuth-protected app:**
```yaml
http:
  middlewares:
    mysite-auth:
      forwardAuth:
        address: "http://host.docker.internal:3000/auth/check"
        authRequestHeaders:
          - "X-Forwarded-Email"
          - "Host"

  routers:
    mysite-router:
      rule: "Host(`mysite.example.com`)"
      middlewares:
        - "mysite-auth"
      service: "mysite-service"
```

---

## API Reference

### New Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/apps` | List all apps |
| `POST` | `/apps` | Create app |
| `GET` | `/apps/:name` | Get app details |
| `PATCH` | `/apps/:name` | Update app config |
| `DELETE` | `/apps/:name` | Delete app |
| `POST` | `/apps/:name/deploy` | Deploy/redeploy |
| `POST` | `/apps/:name/stop` | Stop container |
| `POST` | `/apps/:name/restart` | Restart container |
| `GET` | `/apps/:name/logs` | Get logs |
| `GET` | `/auth/check` | forwardAuth endpoint (no API key) |
| `GET` | `/credentials/registry` | List registry credentials |
| `POST` | `/credentials/registry` | Add registry credential |
| `DELETE` | `/credentials/registry/:id` | Remove credential |
| `GET` | `/credentials/git` | List git credentials |
| `POST` | `/credentials/git` | Add git credential |
| `DELETE` | `/credentials/git/:id` | Remove credential |

### Existing Endpoints (Unchanged)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/sites` | List sites |
| `POST` | `/sites/:subdomain` | Deploy static site |
| `DELETE` | `/sites/:subdomain` | Undeploy site |
| `GET` | `/sites/:subdomain/download` | Download as zip |
| `PATCH` | `/sites/:subdomain/auth` | Update OAuth |
| `GET` | `/health` | Health check |
| `GET` | `/groups` | List groups |
| ... | ... | (all group endpoints unchanged) |

### Example: Create App

```http
POST /apps
Content-Type: application/json
X-API-Key: <key>

{
  "name": "myapi",
  "image": "myregistry/myapi:v1.2.3",
  "internalPort": 3000,
  "env": {
    "NODE_ENV": "production"
  },
  "domains": ["myapi.example.com"]
}
```

Response:
```json
{
  "success": true,
  "data": {
    "name": "myapi",
    "type": "container",
    "status": "pending",
    "createdAt": "2026-01-29T10:00:00Z"
  }
}
```

### Example: Deploy App

```http
POST /apps/myapi/deploy
X-API-Key: <key>
```

Response (blocks until running):
```json
{
  "success": true,
  "data": {
    "name": "myapi",
    "status": "running",
    "containerId": "abc123",
    "deployedAt": "2026-01-29T10:01:00Z"
  }
}
```

---

## CLI Reference

### New Commands

```bash
# App lifecycle
siteio apps create <name> --image <image> [--port <port>]
siteio apps create <name> --git <repo> [--branch <branch>]
siteio apps deploy <name>
siteio apps stop <name>
siteio apps restart <name>
siteio apps rm <name>
siteio apps ls
siteio apps info <name>
siteio apps logs <name> [--tail <n>]

# App configuration
siteio apps set <name> -e KEY=value
siteio apps set <name> -v volumename:/path
siteio apps set <name> -d domain.com
siteio apps set <name> --port <port>
siteio apps set <name> --restart <policy>
siteio apps unset <name> -e KEY
siteio apps unset <name> -d domain.com

# Credentials
siteio registry login <registry> -u <user> -t <token>
siteio registry ls
siteio registry rm <id>

siteio git-credentials add <name> --https -u <user> -t <token>
siteio git-credentials add <name> --ssh --key <path>
siteio git-credentials ls
siteio git-credentials rm <id>
```

### Existing Commands (Unchanged)

```bash
# Static sites
siteio sites deploy <folder> -s <subdomain>
siteio sites list
siteio sites undeploy <subdomain>
siteio sites download <subdomain>
siteio sites auth <subdomain> --allowed-emails <email>
siteio sites info <subdomain>

# Agent
siteio agent start
siteio agent stop
siteio agent restart
siteio agent status
siteio agent install
siteio agent oauth

# Client
siteio login
siteio status

# Groups
siteio groups list
siteio groups create <name>
siteio groups add-email <group> <email>
siteio groups remove-email <group> <email>
siteio groups delete <name>
```

---

## File Structure After Implementation

```
src/
├── cli.ts
├── index.ts
├── types.ts
├── config/
│   ├── loader.ts
│   └── oauth.ts
├── commands/
│   ├── login.ts
│   ├── status.ts
│   ├── groups.ts
│   ├── apps/                     # NEW
│   │   ├── create.ts
│   │   ├── deploy.ts
│   │   ├── stop.ts
│   │   ├── restart.ts
│   │   ├── rm.ts
│   │   ├── list.ts
│   │   ├── info.ts
│   │   ├── set.ts
│   │   ├── unset.ts
│   │   └── logs.ts
│   ├── credentials/              # NEW
│   │   ├── registry.ts
│   │   └── git.ts
│   ├── sites/                    # Updated internally
│   │   ├── deploy.ts
│   │   ├── list.ts
│   │   ├── undeploy.ts
│   │   ├── download.ts
│   │   ├── auth.ts
│   │   └── info.ts
│   └── agent/
│       ├── start.ts
│       ├── stop.ts
│       ├── restart.ts
│       ├── status.ts
│       ├── install.ts
│       └── oauth.ts
├── lib/
│   ├── client.ts
│   └── agent/
│       ├── server.ts
│       ├── docker.ts             # NEW
│       ├── git.ts                # NEW
│       ├── app-storage.ts        # NEW
│       ├── credentials.ts        # NEW
│       ├── storage.ts            # Site files (kept)
│       ├── traefik.ts            # Extended
│       └── groups.ts
└── utils/
    ├── errors.ts
    ├── output.ts
    └── token.ts
```

**Deleted:** `src/lib/agent/fileserver.ts`

---

## Data Directory After Implementation

```
<dataDir>/
├── apps/
│   └── <name>.json               # App metadata
├── sites/
│   └── <name>/                   # Static site files (mounted into nginx)
├── credentials/
│   ├── registry.json             # Docker registry credentials
│   └── git.json                  # Git credentials
├── groups/
│   └── groups.json
├── traefik/
│   ├── traefik.yml
│   └── dynamic.yml
├── certs/
│   └── acme.json
├── oauth.json
└── git/
    └── <name>/                   # Temp: cloned repos during build
```

---

## Container Conventions

All containers are prefixed with `siteio-`:
- `siteio-traefik` — Traefik reverse proxy
- `siteio-oauth2-proxy` — OAuth proxy (if configured)
- `siteio-<appname>` — User apps

All containers join `siteio-network`:
```bash
docker network create siteio-network
```

This allows:
- Traefik to route to containers by name
- Containers to communicate with each other

---

## Backward Compatibility

### For Users

All existing commands work unchanged:
```bash
siteio sites deploy ./dist -s mysite   # Still works
siteio sites list                       # Still works
siteio sites undeploy mysite           # Still works
```

### What Changes Internally

1. Static sites now run as nginx containers (instead of fileserver)
2. Metadata moves from `<dataDir>/metadata/` to `<dataDir>/apps/`
3. OAuth authorization moves from fileserver to `/auth/check`

### Migration

On upgrade, existing sites continue working. New deploys use containers. Optional migration command:

```bash
siteio agent migrate-sites
```

---

## Testing

### Unit Tests

```typescript
describe("DockerManager", () => {
  it("pulls an image")
  it("runs a container")
  it("stops a container")
  it("returns logs")
})

describe("AppStorage", () => {
  it("creates an app")
  it("updates an app")
  it("lists apps")
})
```

### Integration Tests

```typescript
describe("Apps API", () => {
  it("deploys container from image")
  it("deploys container from git")
  it("stops and restarts container")
  it("returns logs")
})

describe("Static Sites as Containers", () => {
  it("deploys site as nginx container")
  it("OAuth forwardAuth works")
})
```

### E2E Tests

```typescript
it("full workflow", async () => {
  await run("siteio apps create myapp --image nginx:alpine --port 80")
  await run("siteio apps set myapp -d myapp.example.com")
  await run("siteio apps deploy myapp")

  const info = await run("siteio apps info myapp")
  expect(info).toContain("running")

  await run("siteio apps rm myapp")
})
```

---

## Future Considerations

These are not part of this implementation but could be added later:

- **Multi-server:** CLI profiles to target different agents
- **Zero-downtime deploys:** Rolling updates with health checks
- **Log streaming:** Real-time `siteio apps logs -f`
- **Container stats:** CPU, memory usage
- **TCP routing:** Non-HTTP services
- **Webhooks:** Auto-deploy on git push
- **Exec:** Run commands in containers

---

## Success Criteria

The implementation is complete when:

- [ ] `siteio apps create myapp --image nginx:alpine` works
- [ ] `siteio apps create myapp --git https://github.com/user/repo` works
- [ ] `siteio apps set myapp -e KEY=value` works
- [ ] `siteio apps logs myapp` works
- [ ] `siteio sites deploy ./dist -s mysite` still works (now uses nginx)
- [ ] OAuth protection works for both static sites and container apps
- [ ] All existing tests pass
- [ ] New tests pass

---

## Reference: Docker Commands

Commands executed by `DockerManager`:

```bash
# Network
docker network create siteio-network

# Pull
docker pull nginx:alpine
docker login -u <user> -p <token> myregistry.com

# Build (for git deploys)
docker build -t siteio-myapp:latest -f Dockerfile .

# Run
docker run -d \
  --name siteio-myapp \
  --network siteio-network \
  --restart unless-stopped \
  -e KEY=value \
  -v volumename:/path \
  -l traefik.enable=true \
  -l "traefik.http.routers.myapp.rule=Host(\`myapp.example.com\`)" \
  -l traefik.http.services.myapp.loadbalancer.server.port=3000 \
  myimage:latest

# Lifecycle
docker stop siteio-myapp
docker rm siteio-myapp
docker logs --tail 100 siteio-myapp
docker inspect siteio-myapp
```

---

## Reference: Traefik Labels

Labels applied to containers:

```bash
-l traefik.enable=true
-l "traefik.http.routers.myapp.rule=Host(\`myapp.example.com\`)"
-l traefik.http.routers.myapp.entrypoints=websecure
-l traefik.http.routers.myapp.tls.certresolver=letsencrypt
-l traefik.http.services.myapp.loadbalancer.server.port=3000

# For OAuth-protected apps
-l traefik.http.routers.myapp.middlewares=myapp-auth
```
