# GitHub Source Deployment Implementation Plan

## Overview

Add the ability to deploy apps from GitHub repositories by specifying a repo URL and Dockerfile path. The siteio agent will clone the repository, build the Docker image locally, and run the container with all existing configuration options (env vars, volumes, domains, OAuth, etc.).

## Current State

### Existing Infrastructure

1. **GitSource interface** already exists in `src/types.ts:34-39`:
   ```typescript
   interface GitSource {
     repoUrl: string
     branch: string
     dockerfile: string
     credentialId?: string  // For future private repo support
   }
   ```

2. **App interface** already has `git?: GitSource` field (`src/types.ts:48`)

3. **DockerManager** (`src/lib/agent/docker.ts`) handles container operations but lacks `build()` and `clone()` functionality

4. **Deployment flow** in `handleDeployApp()` (`src/lib/agent/server.ts:588-640`) currently only supports pulling images

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLI Commands                             │
├─────────────────────────────────────────────────────────────────┤
│  siteio apps create myapp --github <repo> --dockerfile <path>   │
│  siteio apps set myapp --github <repo> --branch <branch>        │
│  siteio apps deploy myapp  (unchanged - auto-detects source)    │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Agent Server                             │
├─────────────────────────────────────────────────────────────────┤
│  POST /apps         - Accept git source in creation             │
│  PATCH /apps/:name  - Update git source                         │
│  POST /apps/:name/deploy - Clone → Build → Run                  │
│  POST /apps/:name/rebuild - Force rebuild from source           │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                     New Components                               │
├─────────────────────────────────────────────────────────────────┤
│  GitManager         - Clone/pull repositories                    │
│  DockerManager.build() - Build images from Dockerfile           │
└─────────────────────────────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Core Infrastructure

#### 1.1 Create GitManager Class

**File:** `src/lib/agent/git.ts`

```typescript
export interface CloneOptions {
  repoUrl: string
  branch: string
  targetDir: string
  shallow?: boolean  // Default true for faster clones
}

export interface PullOptions {
  repoDir: string
  branch: string
}

export class GitManager {
  private dataDir: string
  private reposDir: string  // data/repos/

  constructor(dataDir: string)

  // Get the local path for a repo
  repoPath(appName: string): string

  // Clone a repository (or pull if exists)
  async cloneOrPull(appName: string, options: CloneOptions): Promise<string>

  // Clone fresh (removes existing if present)
  async clone(options: CloneOptions): Promise<void>

  // Pull latest changes
  async pull(options: PullOptions): Promise<void>

  // Check if repo exists locally
  exists(appName: string): boolean

  // Get current commit hash
  async getCommitHash(repoDir: string): Promise<string>

  // Clean up repo directory
  async remove(appName: string): Promise<void>
}
```

**Key Implementation Details:**
- Use `git clone --depth 1 --branch <branch>` for shallow clones
- Store repos in `data/repos/{appName}/`
- Support both HTTPS URLs (`https://github.com/user/repo`) and shorthand (`github:user/repo`)
- Validate Dockerfile exists after clone

#### 1.2 Extend DockerManager with Build Support

**File:** `src/lib/agent/docker.ts` (modify existing)

```typescript
export interface BuildConfig {
  contextPath: string      // Path to build context (cloned repo)
  dockerfile: string       // Relative path to Dockerfile
  tag: string             // Image tag (siteio-{appName}:latest)
  buildArgs?: Record<string, string>  // Optional build arguments
  noCache?: boolean       // Force rebuild without cache
}

// Add to DockerManager class:

/**
 * Build a Docker image from a Dockerfile
 */
async build(config: BuildConfig): Promise<string>

/**
 * Check if a locally built image exists
 */
imageExists(tag: string): boolean

/**
 * Remove a locally built image
 */
async removeImage(tag: string): Promise<void>

/**
 * Generate image tag for an app
 */
imageTag(appName: string): string  // Returns "siteio-{appName}:latest"
```

**Docker Build Command:**
```bash
docker build \
  -t siteio-{appName}:latest \
  -f {dockerfile} \
  --build-arg KEY=value \
  {contextPath}
```

### Phase 2: API & Storage Updates

#### 2.1 Update App Creation/Storage

**File:** `src/lib/agent/app-storage.ts`

Update `create()` to accept git source:
```typescript
create(config: {
  name: string
  image?: string           // Optional if git is provided
  git?: GitSource          // New: GitHub source
  internalPort?: number
  // ... rest unchanged
}): App
```

**Validation Rules:**
- Either `image` OR `git` must be provided, not both
- If `git` is provided:
  - `repoUrl` is required
  - `branch` defaults to "main"
  - `dockerfile` defaults to "Dockerfile"

#### 2.2 Update AppInfo Type

**File:** `src/types.ts`

Add git source to AppInfo for client visibility:
```typescript
interface AppInfo {
  name: string
  type: AppType
  image: string           // For git apps, shows "siteio-{name}:latest"
  git?: GitSource         // New: expose git source info
  status: ContainerStatus
  domains: string[]
  internalPort: number
  deployedAt?: string
  createdAt: string
  lastBuildAt?: string    // New: when image was last built
  commitHash?: string     // New: deployed commit hash
}
```

#### 2.3 Update Server Handlers

**File:** `src/lib/agent/server.ts`

**Modify `handleCreateApp()`:**
- Accept `git` field in request body
- Validate mutual exclusivity of `image` and `git`
- Store git configuration

**Modify `handleDeployApp()`:**
```typescript
private async handleDeployApp(name: string): Promise<Response> {
  const app = this.appStorage.get(name)

  // Determine image source
  let imageToRun: string

  if (app.git) {
    // Clone/pull repository
    const repoPath = await this.git.cloneOrPull(name, {
      repoUrl: app.git.repoUrl,
      branch: app.git.branch,
      targetDir: this.git.repoPath(name),
    })

    // Validate Dockerfile exists
    const dockerfilePath = join(repoPath, app.git.dockerfile)
    if (!existsSync(dockerfilePath)) {
      return this.error(`Dockerfile not found: ${app.git.dockerfile}`, 400)
    }

    // Build image
    const imageTag = this.docker.imageTag(name)
    await this.docker.build({
      contextPath: repoPath,
      dockerfile: app.git.dockerfile,
      tag: imageTag,
    })

    imageToRun = imageTag
  } else {
    // Existing behavior: pull image
    await this.docker.pull(app.image)
    imageToRun = app.image
  }

  // Run container (unchanged from here)
  const containerId = await this.docker.run({
    name: app.name,
    image: imageToRun,
    // ... rest unchanged
  })
}
```

**Add `handleRebuildApp()` (new endpoint):**
```typescript
// POST /apps/:name/rebuild
// Forces a fresh clone and build (no cache)
private async handleRebuildApp(name: string): Promise<Response>
```

### Phase 3: CLI Updates

#### 3.1 Update Create Command

**File:** `src/commands/apps/create.ts`

Add new options:
```typescript
interface CreateAppOptions {
  image?: string           // Now optional
  github?: string          // New: GitHub repo URL
  dockerfile?: string      // New: Dockerfile path (default: "Dockerfile")
  branch?: string          // New: Git branch (default: "main")
  port?: number
  json?: boolean
}
```

**Usage Examples:**
```bash
# From Docker image (existing)
siteio apps create myapp --image nginx:alpine --port 80

# From GitHub repo (new)
siteio apps create myapp --github https://github.com/user/repo --port 3000

# With custom Dockerfile path
siteio apps create myapp --github https://github.com/user/repo \
  --dockerfile docker/Dockerfile.prod \
  --branch develop \
  --port 8080
```

**Validation:**
- Require either `--image` OR `--github`, not both
- Error if neither provided

#### 3.2 Update Set Command

**File:** `src/commands/apps/set.ts`

Add git-related options:
```typescript
interface SetAppOptions {
  // Existing options...
  github?: string          // Change repo URL
  dockerfile?: string      // Change Dockerfile path
  branch?: string          // Change branch
}
```

#### 3.3 Add Rebuild Command

**File:** `src/commands/apps/rebuild.ts` (new)

```typescript
// siteio apps rebuild <name> [--no-cache]
export async function rebuildAppCommand(
  name: string,
  options: { noCache?: boolean; json?: boolean }
): Promise<void>
```

#### 3.4 Update CLI Router

**File:** `src/cli.ts`

Add new command and options:
```typescript
program
  .command("create <name>")
  .description("Create a new app")
  .option("-i, --image <image>", "Docker image")
  .option("-g, --github <url>", "GitHub repository URL")
  .option("--dockerfile <path>", "Dockerfile path (default: Dockerfile)")
  .option("--branch <branch>", "Git branch (default: main)")
  .option("-p, --port <port>", "Internal port", parseInt)
  .action(createAppCommand)

program
  .command("rebuild <name>")
  .description("Rebuild app from source (git apps only)")
  .option("--no-cache", "Build without Docker cache")
  .option("--json", "Output as JSON")
  .action(rebuildAppCommand)
```

### Phase 4: Client Library Updates

**File:** `src/lib/client.ts`

Update `createApp()` signature:
```typescript
async createApp(config: {
  name: string
  image?: string
  git?: {
    repoUrl: string
    branch?: string
    dockerfile?: string
  }
  internalPort?: number
}): Promise<AppInfo>
```

Add `rebuildApp()`:
```typescript
async rebuildApp(name: string, noCache?: boolean): Promise<AppInfo>
```

### Phase 5: Info Display Updates

#### 5.1 Update Info Command

**File:** `src/commands/apps/info.ts`

Display git source information:
```
App: myapp
Source: GitHub
  Repo:       https://github.com/user/repo
  Branch:     main
  Dockerfile: Dockerfile
  Commit:     abc1234
  Built:      2024-01-15T10:30:00Z
Status: running
Port: 3000
Domains: myapp.example.com
```

#### 5.2 Update List Command

**File:** `src/commands/apps/list.ts`

Add source column:
```
NAME     SOURCE              STATUS    DOMAINS
myapp    github:user/repo    running   myapp.example.com
other    nginx:alpine        running   other.example.com
```

## Data Storage

### Directory Structure

```
data/
├── apps/
│   └── myapp.json          # App metadata (includes git config)
├── repos/
│   └── myapp/              # Cloned repository
│       ├── .git/
│       ├── Dockerfile
│       └── src/
├── volumes/
│   └── myapp/
│       └── data/           # Named volumes
└── sites/
    └── ...
```

### App Metadata Example (with git)

```json
{
  "name": "myapp",
  "type": "container",
  "image": "siteio-myapp:latest",
  "git": {
    "repoUrl": "https://github.com/user/repo",
    "branch": "main",
    "dockerfile": "Dockerfile"
  },
  "env": {
    "NODE_ENV": "production"
  },
  "volumes": [],
  "internalPort": 3000,
  "restartPolicy": "unless-stopped",
  "domains": ["myapp.example.com"],
  "status": "running",
  "containerId": "abc123...",
  "commitHash": "def456...",
  "lastBuildAt": "2024-01-15T10:30:00Z",
  "deployedAt": "2024-01-15T10:31:00Z",
  "createdAt": "2024-01-15T10:00:00Z",
  "updatedAt": "2024-01-15T10:31:00Z"
}
```

## Security Considerations

### 1. Repository Access

- **Public repos only (Phase 1):** Start with public GitHub repos
- **Private repos (Future):** Add credential management via `credentialId`
  - Store credentials securely (encrypted at rest)
  - Support GitHub PAT (Personal Access Token)
  - Support deploy keys

### 2. Build Security

- **No arbitrary code execution:** Only run `docker build`, not arbitrary scripts
- **Resource limits:** Consider adding `--memory` and `--cpu-quota` to builds
- **Build timeout:** Add configurable timeout for long builds
- **Dockerfile validation:** Basic validation before building

### 3. URL Validation

- Validate GitHub URLs follow expected patterns
- Prevent SSRF by restricting to known git hosts (github.com, gitlab.com, etc.)
- Sanitize branch names and Dockerfile paths

## Error Handling

### New Error Types

```typescript
// src/utils/errors.ts

export class GitError extends SiteioError {
  constructor(message: string, public repoUrl?: string) {
    super(message)
  }
}

export class BuildError extends SiteioError {
  constructor(message: string, public buildLog?: string) {
    super(message)
  }
}
```

### Error Scenarios

| Scenario | Error Message | HTTP Status |
|----------|--------------|-------------|
| Invalid repo URL | "Invalid GitHub repository URL" | 400 |
| Clone failed | "Failed to clone repository: {details}" | 500 |
| Branch not found | "Branch '{branch}' not found" | 400 |
| Dockerfile not found | "Dockerfile not found at '{path}'" | 400 |
| Build failed | "Docker build failed: {details}" | 500 |
| Build timeout | "Build timed out after {seconds}s" | 500 |

## Testing Strategy

### Unit Tests

1. **GitManager tests** (`src/__tests__/unit/git.test.ts`)
   - URL parsing and validation
   - Repo path generation
   - Clone/pull operations (mocked)

2. **DockerManager build tests** (`src/__tests__/unit/docker-build.test.ts`)
   - Build argument generation
   - Image tag generation
   - Build command construction

### Integration Tests

1. **API tests** (`src/__tests__/api/apps-git.test.ts`)
   - Create app with git source
   - Deploy git-based app
   - Rebuild app
   - Error handling

### E2E Tests

1. **Full flow test** (`src/__tests__/e2e/github-deploy.test.ts`)
   - Create app from public GitHub repo
   - Deploy and verify container runs
   - Update and redeploy

**Test Repository:** Create a simple test repo at `github.com/siteio/test-app` with:
- Basic Node.js app
- Dockerfile
- Multiple branches for testing

## Migration & Compatibility

- **Backward compatible:** Existing apps with `image` continue to work unchanged
- **No migration needed:** `git` field is optional addition
- **API versioning:** Not required, additive change only

## Implementation Order

1. **Week 1: Core Infrastructure**
   - [ ] Create `GitManager` class
   - [ ] Add `build()` method to `DockerManager`
   - [ ] Unit tests for new classes

2. **Week 2: API Updates**
   - [ ] Update `handleCreateApp()` to accept git source
   - [ ] Update `handleDeployApp()` with build logic
   - [ ] Add `handleRebuildApp()` endpoint
   - [ ] API integration tests

3. **Week 3: CLI Updates**
   - [ ] Update `create` command with `--github` option
   - [ ] Update `set` command with git options
   - [ ] Add `rebuild` command
   - [ ] Update `info` and `list` displays

4. **Week 4: Polish & Documentation**
   - [ ] E2E tests
   - [ ] Error handling improvements
   - [ ] Update README and help text
   - [ ] Manual testing

## Future Enhancements

1. **Private repository support** - Add credential management
2. **Webhook triggers** - Auto-deploy on GitHub push
3. **Build caching** - Layer caching across builds
4. **Multi-stage build support** - Optimize for complex Dockerfiles
5. **Build logs streaming** - Real-time build output via WebSocket
6. **GitLab/Bitbucket support** - Expand beyond GitHub
7. **Monorepo support** - Specify subdirectory as build context

## CLI Reference (Final)

```bash
# Create from GitHub
siteio apps create <name> --github <url> [--dockerfile <path>] [--branch <branch>] [-p <port>]

# Create from image (existing)
siteio apps create <name> --image <image> [-p <port>]

# Update git settings
siteio apps set <name> [--github <url>] [--dockerfile <path>] [--branch <branch>]

# Deploy (auto-detects source type)
siteio apps deploy <name>

# Rebuild from source (git apps only)
siteio apps rebuild <name> [--no-cache]

# Other commands unchanged
siteio apps list
siteio apps info <name>
siteio apps stop <name>
siteio apps restart <name>
siteio apps rm <name>
siteio apps logs <name>
```

## Summary

This implementation adds GitHub repository support as a deployment source while maintaining full backward compatibility with existing Docker image deployments. The key additions are:

1. **GitManager** - Handles repository cloning and updates
2. **DockerManager.build()** - Builds images from Dockerfiles
3. **CLI options** - `--github`, `--dockerfile`, `--branch` flags
4. **New endpoint** - `POST /apps/:name/rebuild` for force rebuilds

All existing functionality (env vars, volumes, domains, OAuth, restart policies) works identically for both image-based and git-based apps.
