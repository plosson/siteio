# CLAUDE.md

## What is siteio?

A self-hosted deployment platform for **static websites** and **Docker containers** with automatic HTTPS via Traefik.

### Features
- **Static sites**: Deploy folders as websites (`siteio sites deploy ./folder`)
- **Container apps**: Deploy Docker images (`siteio apps create myapp -i nginx -p 80`)
- **Automatic HTTPS**: Traefik handles Let's Encrypt certificates
- **OAuth protection**: Restrict access by email, domain, or groups
- **Two modes**: CLI client talks to a remote agent server

### Not Yet Supported
- Deploy directly from GitHub repos (must clone locally first)
- Build Docker images from source/Dockerfile
- Private Git repository credentials

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

1. Bump version in `package.json`
2. Commit: `git commit -am "Bump version to X.Y.Z"`
3. Push: `git push`
4. Tag: `git tag vX.Y.Z && git push origin vX.Y.Z`

GitHub Actions builds binaries and creates a release when a tag is pushed.
