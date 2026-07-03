import { existsSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"

const STARTER_INDEX = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>My Site</title>
</head>
<body>
  <h1>It works</h1>
  <p>Deployed with siteio sites.</p>
</body>
</html>
`

// A guide dropped into the project so an AI assistant understands what siteio
// static sites can do and how to deploy and configure one. Kept intentionally
// short and practical, mirroring the pocket and app scaffold guides.
const CLAUDE_MD = `# siteio site — project guide (for the AI assistant)

This folder is a **siteio static site**: plain HTML/CSS/JS deployed behind
Traefik with automatic HTTPS. There is no build step and no server — every
file in this folder is served as-is at \`https://<name>.<domain>\`.

## Commands

- \`siteio sites deploy\` — deploy this folder live in one command.
- \`siteio sites info\` — live URL, size, and version.
- \`siteio sites download\` — pull the deployed files back into a folder.
- \`siteio sites history\` / \`siteio sites rollback\` — every deploy is versioned; roll back any time.
- \`siteio sites list\` / \`siteio sites rm\` / \`siteio sites rename --to <new>\`

Commands resolve the site name from \`.siteio/config.json\` in this folder;
pass \`-s <name>\` (\`-n\` for download) to target another site.

## Protecting the site with OAuth

Restrict who can open the site — login is enforced at the proxy, no code changes:

- \`siteio sites auth --allowed-emails a@x.com,b@y.com\`
- \`siteio sites auth --allowed-domain example.com\`
- \`siteio sites auth --allowed-groups team\` (manage groups with \`siteio groups\`)
- \`siteio sites auth --remove\` — make it public again

## Custom domains

- \`siteio sites domain add example.com\` (point the domain's DNS at the server first)
- \`siteio sites set -d example.com -d www.example.com\` — replace the full list

## IMPORTANT: if the site needs to store data — persistent localStorage

A static site has no backend, but siteio can persist \`localStorage\`
server-side: enable it with \`siteio sites set --persistent-storage\`, then use
plain \`localStorage\` in the code as usual. siteio injects a shim that syncs
it to the server (per logged-in user when OAuth is on, shared otherwise;
1MB limit), so data survives across browsers and devices.

If the site needs real auth, a database, file uploads, or an API — use a
**siteio pocket** instead (\`siteio pocket init\`): the same static hosting
plus a PocketBase backend.
`

export function scaffoldSite(dir: string): { created: string[] } {
  const created: string[] = []
  const write = (rel: string, content: string) => {
    const full = join(dir, rel)
    if (existsSync(full)) return
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, content)
    created.push(rel)
  }

  write("index.html", STARTER_INDEX)
  write("CLAUDE.md", CLAUDE_MD)

  return { created }
}
