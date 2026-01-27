# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

siteio is a CLI tool and server for deploying static sites. It has two modes:
- **Client mode**: CLI commands (`siteio sites deploy`, `siteio sites list`, etc.) that interact with a remote agent
- **Agent mode**: A server (`siteio agent start`) that receives deployments, stores files, and manages Traefik for HTTPS/routing

## Commands

```bash
# Development
bun run dev              # Run CLI with --watch
bun run start            # Run CLI directly
bun run typecheck        # TypeScript type checking

# Testing
bun test                 # Run all tests
bun test src/__tests__/deploy.test.ts    # Run single test file
```

## Architecture

```
src/
├── cli.ts              # Entry point, commander-based CLI routing
├── index.ts            # Library exports (SiteioClient, AgentServer, etc.)
├── types.ts            # Shared TypeScript types
├── config/
│   └── loader.ts       # Reads/writes ~/.config/siteio/config.json
├── commands/
│   ├── login.ts        # siteio login
│   ├── sites/          # siteio sites [deploy|list|undeploy]
│   └── agent/
│       └── start.ts    # siteio agent start
├── lib/
│   ├── client.ts       # SiteioClient - API client for talking to agent
│   └── agent/
│       ├── server.ts   # AgentServer - Bun.serve HTTP server
│       ├── storage.ts  # SiteStorage - file extraction and metadata
│       ├── traefik.ts  # TraefikManager - generates configs, spawns Traefik
│       └── fileserver.ts # Static file serving for deployed sites
└── utils/
    ├── errors.ts       # Error classes (ValidationError, ApiError, ConfigError)
    └── output.ts       # CLI output formatting helpers
```

## Key Patterns

- **Dual output**: Commands output JSON to stdout (for scripting) and human-readable progress to stderr
- **Zip-based deployment**: Client zips folder → sends to agent → agent extracts to `<dataDir>/sites/<subdomain>/`
- **Host-based routing**: Agent routes `api.<domain>` to API handlers, `<subdomain>.<domain>` to static files
- **Traefik integration**: Agent spawns Traefik and dynamically updates `dynamic.yml` when sites change

## Environment Variables (Agent Mode)

Required:
- `SITEIO_DOMAIN` - Base domain for sites (e.g., `axel.siteio.me`)

Optional:
- `SITEIO_API_KEY` - API key (auto-generated if not set)
- `SITEIO_DATA_DIR` - Data directory (default: `/data`)
- `SITEIO_MAX_UPLOAD_SIZE` - Max upload size (default: `50MB`)
- `SITEIO_HTTP_PORT` / `SITEIO_HTTPS_PORT` - Traefik ports (default: `80`/`443`)
- `SITEIO_EMAIL` - Email for Let's Encrypt

## Testing Notes

- Tests use `skipTraefik: true` to run without Traefik
- E2E tests spin up a real `AgentServer` on a custom port
- Integration tests run the CLI as a subprocess

## Releasing a New Version

1. Bump version in `package.json`
2. Commit: `git commit -am "Bump version to X.Y.Z"`
3. Push: `git push`
4. Create and push tag: `git tag vX.Y.Z && git push origin vX.Y.Z`

The Release workflow builds binaries and creates a GitHub release when a tag is pushed.
