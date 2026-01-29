# Git Source Deployment - Implementation Complete

## Overview

Apps can now be deployed from Git repositories by specifying a repo URL and Dockerfile path. The siteio agent clones the repository, builds the Docker image locally, and runs the container with all existing configuration options (env vars, volumes, domains, OAuth, etc.).

## Key Design Decisions

Based on brainstorming session:

1. **`--git` flag** (not `--github`) - Supports any Git provider (GitHub, GitLab, Bitbucket, self-hosted)
2. **No separate `rebuild` command** - Use `deploy --no-cache` instead
3. **Monorepo support via `--context`** - Specify subdirectory as build context
4. **`--dockerfile` relative to context** - Matches Docker's default behavior
5. **Simple GitManager class** - Consistent with existing patterns (DockerManager, AppStorage)

## CLI Reference

### Create from Git

```bash
# Basic
siteio apps create <name> --git <url> -p <port>

# With options
siteio apps create <name> --git <url> \
  --branch <branch>         # Default: main
  --dockerfile <path>       # Default: Dockerfile (relative to context)
  --context <path>          # Subdirectory for monorepos
  -p <port>
```

### Deploy

```bash
# Normal deploy (clones, builds, runs)
siteio apps deploy <name>

# Force rebuild without Docker cache
siteio apps deploy <name> --no-cache
```

### Examples

```bash
# Simple app from GitHub
siteio apps create myapi --git https://github.com/user/repo -p 3000
siteio apps deploy myapi

# Monorepo with custom Dockerfile
siteio apps create backend --git https://github.com/user/monorepo \
  --context services/api \
  --dockerfile Dockerfile.prod \
  --branch develop \
  -p 8080
siteio apps deploy backend

# Force rebuild without cache
siteio apps deploy myapi --no-cache
```

## Implementation Summary

### New Files

- `src/lib/agent/git.ts` - GitManager class for cloning repos

### Modified Files

- `src/types.ts` - Added `context` to GitSource, updated AppInfo
- `src/lib/agent/docker.ts` - Added `build()`, `imageTag()`, `imageExists()`, `removeImage()`
- `src/lib/agent/server.ts` - Updated create/deploy handlers for git sources
- `src/lib/agent/app-storage.ts` - Updated `toInfo()` to include git fields
- `src/lib/client.ts` - Updated `createApp()` and `deployApp()` signatures
- `src/commands/apps/create.ts` - Added git options
- `src/commands/apps/deploy.ts` - Added `--no-cache` option
- `src/commands/apps/info.ts` - Display git source details
- `src/commands/apps/list.ts` - Show source type (git vs image)
- `src/cli.ts` - Added CLI flags

### Tests Added

- `src/__tests__/unit/git.test.ts` - GitManager unit tests
- `src/__tests__/api/apps-git.test.ts` - API integration tests

## Data Model

### App with Git Source

```json
{
  "name": "myapp",
  "type": "container",
  "image": "siteio-myapp:latest",
  "git": {
    "repoUrl": "https://github.com/user/repo",
    "branch": "main",
    "dockerfile": "Dockerfile",
    "context": "services/api"
  },
  "internalPort": 3000,
  "status": "running",
  "commitHash": "abc1234...",
  "lastBuildAt": "2024-01-15T10:30:00Z",
  "deployedAt": "2024-01-15T10:31:00Z"
}
```

## Validation Rules

- Either `--image` OR `--git` must be provided, not both
- Git URL is required when using `--git`
- Branch defaults to "main"
- Dockerfile defaults to "Dockerfile"
- Dockerfile path is relative to context (or repo root if no context)

## Future Enhancements

1. **Private repository support** - Add credential management (`credentialId` field exists)
2. **Webhook triggers** - Auto-deploy on git push
3. **Build logs streaming** - Real-time build output
4. **GitLab/Bitbucket shortcuts** - `gitlab:user/repo` syntax
