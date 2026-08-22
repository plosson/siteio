# CLAUDE.md

# Agent Instructions

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **Run quality gates** (if code changed) - Tests, linters, builds
2. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
3. **Clean up** - Clear stashes, prune remote branches
4. **Verify** - All changes committed AND pushed
5. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

## What is siteio?

A self-hosted deployment platform for **websites** and **Docker containers** with automatic HTTPS via Traefik.

### Features
- **Sites**: Deploy folders as websites (`siteio sites deploy ./folder`). Every site runs in its own PocketBase container: static frontend plus optional backend (auth, database, file storage, realtime) at `/api`
- **Local dev**: `siteio sites dev` runs a site + backend locally without Docker
- **Container apps**: Deploy Docker images (`siteio apps create myapp -i nginx -p 80`)
- **Git deployments**: Build from Git repos (`siteio apps create myapp --git <url> -p 3000`)
- **Monorepo support**: Specify build context with `--context <path>`
- **Custom domains, history/rollback, rename**: `siteio sites domain|history|rollback|rename`
- **Automatic HTTPS**: Traefik handles Let's Encrypt certificates
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

AI site-chat editor (optional; enables the "Chat" tab on a site — edit a site by
chatting with an LLM that redeploys it — plus the **in-site live editor**: run
`siteio sites edit <site>` to mint a one-time link that opens an Intercom-style
chat bubble *on the deployed site itself* (`<site>.<domain>/_siteio/edit`), where
edits land in place. Phase 1 is owner-only. Configured iff a credential is set:
- `SITEIO_LLM_OAUTH_TOKEN` - Claude subscription token from `claude setup-token` (preferred), or `CLAUDE_CODE_OAUTH_TOKEN`
- `SITEIO_LLM_API_KEY` - Anthropic API key (alternative to a subscription token)
- `SITEIO_LLM_MODEL` - optional model override (e.g. `claude-sonnet-5`)
- `SITEIO_CHAT_SANDBOX` - run the agent in a throwaway container (default `true`; set `false` only for trusted single-tenant/dev). Sandbox needs the image: `docker build -t siteio-chat-sandbox:latest docker/chat-sandbox`
- `SITEIO_CHAT_SANDBOX_IMAGE` / `SITEIO_CHAT_SANDBOX_NETWORK` / `SITEIO_CHAT_MAX_TURNS` / `SITEIO_CHAT_TIMEOUT_MS` - sandbox/limit overrides

The credential/model can also be persisted (instead of env) via the agent config CLI, which writes to `agent-config.json` (0600; credentials masked in `config list`): `siteio agent config set llmOauthToken <token>` (or `llmApiKey`, `llmModel`, `llmProvider`). Env vars win over persisted values; restart the agent after changing either.

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

### Update SiteIO.me server

1. Run on the remote server accessible through `ssh siteio`:
   ```bash
   ssh siteio "/root/.local/bin/siteio update -y && /root/.local/bin/siteio agent restart"
   ```
