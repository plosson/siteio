# CLAUDE.md

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
