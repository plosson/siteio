// Embedded SKILL.md content for installation
// This is included in the binary so it can be installed without network access

export const SKILL_CONTENT = `---
name: siteio
description: Deploy websites to a URL using siteio. Use when the user wants to deploy a website, static site, HTML files, or asks to publish/host a site — including sites that need auth, a database, or file storage.
argument-hint: "[folder] [-n name]"
allowed-tools: Bash(siteio *)
---

# Deploy with siteio

siteio is a self-hosted deployment platform for **websites** and **Docker container apps** with automatic HTTPS. Every site ships with a built-in backend (PocketBase: auth, database, file storage, REST + realtime API) — using it is optional; a plain folder of HTML deploys as-is.

## Discovering Commands

Use \`--help\` at any level to discover subcommands and options:

\`\`\`sh
siteio --help              # Top-level commands
siteio sites --help        # Site commands
siteio sites deploy --help # Deploy options
siteio apps --help         # Container app commands
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

## Quick Start: Sites

Deploy a folder of static files (HTML, CSS, JS, images) as a website:

\`\`\`sh
siteio sites deploy ./dist -n myapp
\`\`\`

- The folder should contain an \`index.html\` at the root
- Sites are served at \`https://<name>.<domain>\` with automatic HTTPS
- Deploying to the same name replaces the site's code; its data is preserved

## Sites with auth, database, or storage

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

## Quick Start: Container Apps

Deploy Docker images or build from Git repos:

\`\`\`sh
siteio apps create myapp -i nginx -p 80
siteio apps create myapp --git <url> -p 3000
\`\`\`

## Editing an Existing Site

When a user wants to edit a site by giving its URL (e.g., \`https://mysite.example.com\`):

1. Extract the name from the URL (e.g., \`mysite\`)
2. Download: \`siteio sites download /tmp/mysite-edit -n mysite\`
3. Edit the files in \`/tmp/mysite-edit/\`
4. Re-deploy: \`siteio sites deploy /tmp/mysite-edit -n mysite\`

## Key Features

- **Custom domains**: \`siteio sites domain add <domain>\` / \`siteio apps set -d <domain>\`
- **Version history & rollback**: \`siteio sites history\` / \`siteio sites rollback\` (code only — data is never rolled back)
- **Backend logs**: \`siteio sites logs\`
- **Rename**: \`siteio sites rename <new-name>\`
`
