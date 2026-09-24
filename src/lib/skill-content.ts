// Embedded agent skill, split in three so an agent only loads what it needs:
// SKILL_CONTENT is the overview (`siteio skill`, and the SKILL.md that
// `siteio skill install` writes); SITES_SKILL and APPS_SKILL are the details
// (`siteio sites skill`, `siteio apps skill`). Shipped in the binary so it
// works offline and the PocketBase versions it states match this build.
import { POCKETBASE_JS_SDK_VERSION, POCKETBASE_VERSION } from "./pocketbase-version.ts"

export const SKILL_CONTENT = `---
name: siteio
description: Deploy websites and Docker apps to a URL using siteio. Use when the user wants to deploy, publish or host a website, static site or HTML files — including sites that need auth, a database, or file storage (a siteio site, backed by PocketBase) — or a Docker image, Dockerfile, Git repo or docker-compose service (a siteio app).
argument-hint: "[folder] [-n name]"
allowed-tools: Bash(siteio *)
---

# siteio

siteio is a self-hosted deployment platform with automatic HTTPS. It deploys
**two different kinds of things**, each with its own command group:

| | **Sites** — \`siteio sites …\` | **Apps** — \`siteio apps …\` |
|---|---|---|
| What you deploy | A folder of web files (HTML, CSS, JS, images) | A Docker container: an image, a Dockerfile, a Git repo, or a docker-compose file |
| Runs on | PocketBase, one container per site, managed by siteio | Your own container |
| Backend | Built in at \`/api\` (PocketBase): auth, database, file storage, realtime. Optional — plain HTML deploys as-is | Whatever your container runs (Node, Python, Go, a database, …) |
| Use for | Static sites, SPAs, and apps whose backend fits PocketBase | Custom servers, existing Docker images, other stacks, background services |
| URL | \`https://<name>.<domain>\` | \`https://<name>.<domain>\` |

**Which one?** Default to a **site**. Choose an **app** only when you need your
own server process or an existing Docker image — not just to get auth, a database
or file storage (sites already have those).

## Discovering Commands

Use \`--help\` at any level to discover subcommands and options:

\`\`\`sh
siteio --help              # Top-level commands
siteio sites --help        # Site commands (PocketBase)
siteio apps --help         # App commands (Docker)
\`\`\`

**Always use \`--help\` to check exact syntax before running a command.**

## Installation

\`\`\`sh
curl -LsSf https://siteio.houlahop.com/install | sh
siteio update              # Ensure latest version
\`\`\`

## Setup

The user needs a connection token from their siteio administrator:

\`\`\`sh
siteio login -t <token>
\`\`\`

## Next: load the guide for what you are deploying

This overview is not enough to work with either kind. Before running any
\`siteio sites\` or \`siteio apps\` command, print the matching guide:

\`\`\`sh
siteio sites skill   # Sites: deploy, backend (auth/database/storage), PocketBase docs, editing, sharing
siteio apps skill    # Apps: create & deploy containers, config, domains, logs
\`\`\`
`

export const SITES_SKILL = `# siteio sites — websites on PocketBase

A site is a folder of web files served at \`https://<name>.<domain>\`, with a
built-in PocketBase backend at \`/api\`. Check exact syntax with
\`siteio sites <command> --help\`.

## Quick start

Deploy a folder of static files (HTML, CSS, JS, images) as a website:

\`\`\`sh
siteio sites deploy ./dist -n myapp
\`\`\`

- The folder should contain an \`index.html\` at the root
- Sites are served at \`https://<name>.<domain>\` with automatic HTTPS
- Deploying to the same name replaces the site's code; its data is preserved

## Auth, database, or storage

Do NOT write a custom server. Every site has a PocketBase backend at \`/api\`:

\`\`\`sh
siteio sites init ./myapp   # Scaffold: index.html + starter schema migration + guide
siteio sites dev            # Run locally with the backend, no Docker required
siteio sites deploy         # Ship it
siteio sites admin          # Backend dashboard URL + superuser credentials
\`\`\`

Define collections in \`.siteio/pb_migrations/*.js\` and use the PocketBase JS
SDK in the browser (\`new PocketBase(window.location.origin)\`). The scaffolded
CLAUDE.md explains the patterns.

## PocketBase version & docs

This siteio build uses **PocketBase ${POCKETBASE_VERSION}** and the browser **JS SDK
${POCKETBASE_JS_SDK_VERSION}**. New sites start on that version. An existing site may still
run an older one: check the \`PB\` column of \`siteio sites list\` (or \`siteio sites info\`).

Markdown references, pinned to these versions:

- JS SDK (auth, CRUD, filters, realtime, files): https://raw.githubusercontent.com/pocketbase/js-sdk/v${POCKETBASE_JS_SDK_VERSION}/README.md
- What changed between versions: https://raw.githubusercontent.com/pocketbase/pocketbase/v${POCKETBASE_VERSION}/CHANGELOG.md
- Hooks & migrations API (every global, type and method): \`.siteio/pb_data/types.d.ts\`,
  generated when \`siteio sites dev\` runs

Official docs (HTML, track the latest PocketBase release):

- Overview: https://pocketbase.io/docs/
- Collections & API rules/filters: https://pocketbase.io/docs/collections/, https://pocketbase.io/docs/api-rules-and-filters/
- Authentication (password, OAuth2, OTP/MFA): https://pocketbase.io/docs/authentication/
- Files: https://pocketbase.io/docs/files-handling/
- Realtime: https://pocketbase.io/docs/api-realtime/
- JS hooks (\`.siteio/pb_hooks/*.pb.js\`): https://pocketbase.io/docs/js-overview/
- JS migrations (\`.siteio/pb_migrations/*.js\`): https://pocketbase.io/docs/js-migrations/

## Editing an existing site

When a user wants to edit a site by giving its URL (e.g., \`https://mysite.example.com\`):

1. Extract the name from the URL (e.g., \`mysite\`)
2. Download: \`siteio sites download /tmp/mysite-edit -n mysite\`
3. Edit the files in \`/tmp/mysite-edit/\`
4. Re-deploy: \`siteio sites deploy /tmp/mysite-edit -n mysite\`

## Sharing a site for editing (delegate to another person's AI)

Let someone else edit and redeploy a site without giving them your credentials:

\`\`\`sh
siteio sites share mysite                    # grant access (stays valid until revoked)
siteio sites share mysite --label "Sam"      # attribute their deploys in history
siteio sites share mysite --allow-backend    # also allow backend edits (affects live data)
siteio sites share list mysite               # see active grants
siteio sites share revoke <id> -n mysite     # revoke access
\`\`\`

This prints access that works several ways (send the invitee whichever fits their AI). All
share the same one-time **share code** and OAuth, and all are confined to that one site's
**web files** — never other sites, admin, or (unless \`--allow-backend\`) the backend:

- **CLI** (coding agents with a shell — Codex, Claude Code, Cursor): a \`siteio login -t <token>\`
  they paste, then \`siteio sites download\` / edit locally (images and all) / \`siteio sites deploy\`.
- **MCP connector** at \`https://mysite.<domain>/mcp\` (same for everyone; the code is entered when
  the connector authorizes via OAuth): full web-file editing tools (list/read/write/edit/delete/deploy)
  directly in the AI.

Access stays valid until you revoke it; the token/code is shown once.

## More site commands

- **Custom domains**: \`siteio sites domain add <domain>\`
- **Version history & rollback**: \`siteio sites history\` / \`siteio sites rollback\` (code only — data is never rolled back)
- **Backend logs**: \`siteio sites logs\`
- **Rename**: \`siteio sites rename <new-name>\`
`

export const APPS_SKILL = `# siteio apps — Docker containers

An app is a Docker container served at \`https://<name>.<domain>\`. Check exact
syntax with \`siteio apps <command> --help\`.

## Quick start

Create the app, then deploy it — \`create\` only registers it, \`deploy\` builds and starts the container:

\`\`\`sh
siteio apps create myapp -i nginx -p 80            # from a Docker image
siteio apps create myapp --git <url> -p 3000       # built from a Git repo (--context for monorepos)
siteio apps create myapp -f ./Dockerfile -p 3000   # from a local, self-contained Dockerfile
siteio apps deploy myapp
\`\`\`

\`siteio apps create myapp -i nginx -p 80 --deploy\` does both in one step.

\`deploy\` then checks that the containers stay up and the public URL answers over HTTPS. If not, it prints the failing service's last log lines and exits non-zero, so there is no need to poll the URL yourself (\`--no-wait\` skips the checks).

\`siteio apps init ./myapp\` scaffolds a Dockerfile project with an AI guide.
\`siteio apps create --help\` covers private Git repos.

## Docker Compose apps

\`\`\`sh
siteio apps create myapp --compose-file docker-compose.yml --service web -p 3000
siteio apps create myapp --git <url> --compose docker-compose.yml --service web -p 3000
siteio apps deploy myapp
\`\`\`

- \`--service\` is the one service that gets public traffic, and \`-p\` is the port it listens on inside its container.
- siteio adds its own file on top of yours. It connects that service to its proxy, keeping the networks it already had, and adds the routing. The other services stay on the stack's own network and reach each other by service name (\`redis\`, \`db\`).
- Only the compose file is uploaded, plus \`--env-file\` if given, not the folder around it. Use named volumes for data, not \`./data\` bind mounts. Named volumes keep their data across deploys.
- Don't publish \`ports:\` (the proxy serves the app over HTTPS) and don't set \`container_name:\`.
- Where the app needs its public address, use \`\${SITEIO_URL}\` (also \`\${SITEIO_DOMAIN}\` and \`\${SITEIO_APP}\`), for example \`APP_URL: \${SITEIO_URL}\`.
- \`apps set -e\` variables and \`-v\` volumes apply to the public service only.
- \`create\` and \`set\` check the file and print warnings. Read them before deploying.
- To change the stack, don't remove the app. Run \`siteio apps set myapp --compose-file docker-compose.yml\` (also \`--env-file\`, \`--service\`), then \`siteio apps deploy myapp\`. For a Git stack, push the change and redeploy.
- Logs of the other services: \`siteio apps logs myapp --service <name>\` or \`--all\`.

## More app commands

- **Config**: \`siteio apps set myapp -e KEY=value\` (also \`--secret\`, \`-v\` volumes, \`-p\` port), then \`siteio apps deploy myapp\` to apply
- **Custom domains**: \`siteio apps set myapp -d <domain>\`
- **Lifecycle**: \`siteio apps stop|restart|rm myapp\`
- **Logs**: \`siteio apps logs myapp\`
`
