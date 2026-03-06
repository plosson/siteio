// Embedded SKILL.md content for installation
// This is included in the binary so it can be installed without network access

export const SKILL_CONTENT = `---
name: siteio
description: Deploy static sites to a URL using siteio. Use when the user wants to deploy a website, static site, HTML files, or asks to publish/host a site.
argument-hint: "[folder] [-s subdomain]"
allowed-tools: Bash(siteio *)
---

# Deploy with siteio

siteio is a self-hosted deployment platform for **static websites** and **Docker container apps** with automatic HTTPS.

## Discovering Commands

Use \`--help\` at any level to discover subcommands and options:

\`\`\`sh
siteio --help              # Top-level commands
siteio sites --help        # Static site commands
siteio sites deploy --help # Deploy options
siteio apps --help         # Container app commands
\`\`\`

**Always use \`--help\` to check exact syntax before running a command.**

## Installation

\`\`\`sh
curl -LsSf https://siteio.me/install | sh
siteio update              # Ensure latest version
\`\`\`

## Setup

The user needs a connection token from their siteio administrator:

\`\`\`sh
siteio login -t <token>
\`\`\`

## Quick Start: Static Sites

Deploy a folder of static files (HTML, CSS, JS, images) as a website:

\`\`\`sh
siteio sites deploy ./dist -s myapp
\`\`\`

- The folder must contain an \`index.html\` at the root
- Sites are served at \`https://<subdomain>.<domain>\` with automatic HTTPS
- Deploying to the same subdomain replaces the existing site

## Quick Start: Container Apps

Deploy Docker images or build from Git repos:

\`\`\`sh
siteio apps create myapp -i nginx -p 80
siteio apps create myapp --git <url> -p 3000
\`\`\`

## Editing an Existing Site

When a user wants to edit a site by giving its URL (e.g., \`https://mysite.example.com\`):

1. Extract the subdomain from the URL (e.g., \`mysite\`)
2. Download: \`siteio sites download /tmp/mysite-edit -s mysite\`
3. Edit the files in \`/tmp/mysite-edit/\`
4. Re-deploy: \`siteio sites deploy /tmp/mysite-edit -s mysite\`

## Key Features

- **OAuth protection**: \`siteio sites auth --help\` for access control options
- **Custom domains**: \`siteio sites set --help\` / \`siteio apps set --help\`
- **Version history & rollback**: \`siteio sites history\` / \`siteio sites rollback\`
- **Groups**: \`siteio groups --help\` for managing OAuth groups
`
