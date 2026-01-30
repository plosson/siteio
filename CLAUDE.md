# CLAUDE.md

# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress  # Claim work
bd close <id>         # Complete work
bd sync               # Sync with git
```

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

## What is siteio?

A self-hosted deployment platform for **static websites** and **Docker containers** with automatic HTTPS via Traefik.

### Features
- **Static sites**: Deploy folders as websites (`siteio sites deploy ./folder`)
- **Container apps**: Deploy Docker images (`siteio apps create myapp -i nginx -p 80`)
- **Git deployments**: Build from Git repos (`siteio apps create myapp --git <url> -p 3000`)
- **Monorepo support**: Specify build context with `--context <path>`
- **Automatic HTTPS**: Traefik handles Let's Encrypt certificates
- **OAuth protection**: Restrict access by email, domain, or groups
- **Two modes**: CLI client talks to a remote agent server

### Not Yet Supported
- Private Git repository credentials (public repos only)

## Development Commands

```bash
bun run dev              # Run CLI with --watch
bun run start            # Run CLI directly
bun run typecheck        # TypeScript type checking
bun test                 # Run all tests
bun test src/__tests__/deploy.test.ts   # Single test file
```

## Testing Conventions

- Tests use `skipTraefik: true` to run without Traefik
- E2E tests spin up a real `AgentServer` on a random port
- Use `bun test` - the project uses Bun's built-in test runner

## Key Patterns to Follow

- **Dual output**: Commands output JSON to stdout (for scripting), human-readable to stderr
- **Error handling**: Use error classes from `utils/errors.ts` (ValidationError, ApiError, ConfigError)
- **CLI output**: Use helpers from `utils/output.ts` for consistent formatting

## Environment Variables (Agent Mode)

Required:
- `SITEIO_DOMAIN` - Base domain (e.g., `myserver.example.com`)

Optional:
- `SITEIO_API_KEY` - API key (auto-generated if not set)
- `SITEIO_DATA_DIR` - Data directory (default: `/data`)
- `SITEIO_EMAIL` - Email for Let's Encrypt

## Releasing

Follow this when the user asks to "release a new version" or mentions "bump the version"

### Version Bumping (Semver)

- **Patch** (1.0.x): Bug fixes, minor tweaks
- **Minor** (1.x.0): New features, backward compatible
- **Major** (x.0.0): Breaking changes

### Release Steps

1. Bump version in `package.json`
2. Commit: `git commit -am "Bump version to X.Y.Z"`
3. Push: `git push`
4. Tag: `git tag vX.Y.Z && git push origin vX.Y.Z`
5. Share the Actions link so user can follow build progress:
   https://github.com/plosson/siteio/actions

GitHub Actions builds binaries and creates a release when a tag is pushed.
