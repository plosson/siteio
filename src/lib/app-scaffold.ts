import { existsSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"

// Self-contained starter: siteio builds inline Dockerfiles remotely with an
// EMPTY build context, so COPY/ADD of local files would fail. Content is
// embedded inline; real codebases should switch to a git-based app.
const STARTER_DOCKERFILE = `# Built remotely with an EMPTY build context: COPY/ADD of local files will
# fail. Embed content inline like below, or use a git-based app for real
# codebases (see CLAUDE.md).
FROM nginx:alpine
RUN printf '<h1>It works</h1><p>Deployed with siteio apps.</p>' > /usr/share/nginx/html/index.html
EXPOSE 80
`

// A guide dropped into the project so an AI assistant understands what siteio
// apps can do and how to build, configure, and operate one. Kept intentionally
// short and practical, mirroring the pocket scaffold guide.
const CLAUDE_MD = `# siteio app — project guide (for the AI assistant)

This folder is a **siteio app**: a Docker container deployed behind Traefik
with automatic HTTPS. You edit the Dockerfile here; the \`siteio\` CLI builds
and runs it on the server, reachable at \`https://<name>.<domain>\`.

## Workflow

1. Create the app once (use the folder name recorded in \`.siteio/config.json\`):
   \`siteio apps create <name> -f Dockerfile -p 80\`
2. Iterate: edit the Dockerfile, then rebuild and redeploy with
   \`siteio apps deploy -f Dockerfile\`

## IMPORTANT: inline Dockerfiles are built with an EMPTY build context

Only the Dockerfile itself is uploaded — \`COPY\`/\`ADD\` of local files will
fail. Embed content inline (\`RUN printf ... > file\`) or use a git-based app
for real codebases:

- \`siteio apps create <name> --git <repo-url> -p 3000\` — clones and builds the repo's Dockerfile remotely
- \`--branch <b>\` (default: main), \`--dockerfile <path>\`, \`--context <subdir>\` for monorepos
- \`--git-token <token>\` for private HTTPS repos
- Redeploy after pushing: \`siteio apps deploy\` (add \`--no-cache\` for a clean build)

## Other sources

- Plain image, no build: \`siteio apps create <name> -i nginx -p 80\`
- Docker Compose (multi-container): \`siteio apps create <name> --compose-file docker-compose.yml --service web\`
  — \`--service\` picks the container exposed publicly; \`--env-file .env\` ships variables

## Configuration — siteio apps set

- Env vars: \`siteio apps set -e KEY=value\` (remove with \`siteio apps unset -e KEY\`)
- Volumes (persistent storage): \`siteio apps set -v data:/var/lib/data\`
- Custom domains: \`siteio apps set -d example.com\`
- Internal port: \`siteio apps set -p 8080\`
- Restart policy: \`siteio apps set -r unless-stopped\`

Run \`siteio apps restart\` after \`set\` for changes to take effect.

## Operations

- \`siteio apps info\` — live URL, status, and configuration
- \`siteio apps logs\` — tail container logs (\`-t 200\` lines, \`--service <name>\` for compose apps)
- \`siteio apps stop\` / \`siteio apps restart\`
- \`siteio apps list\` / \`siteio apps rm\`

Commands resolve the app name from \`.siteio/config.json\` in this folder;
pass a name explicitly to target another app.
`

export function scaffoldApp(dir: string): { created: string[] } {
  const created: string[] = []
  const write = (rel: string, content: string) => {
    const full = join(dir, rel)
    if (existsSync(full)) return
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, content)
    created.push(rel)
  }

  write("Dockerfile", STARTER_DOCKERFILE)
  write("CLAUDE.md", CLAUDE_MD)

  return { created }
}
