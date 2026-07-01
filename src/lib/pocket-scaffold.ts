import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "fs"
import { join } from "path"

const STARTER_INDEX = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>My Pocket</title>
  <script src="https://cdn.jsdelivr.net/npm/pocketbase@0.22.0/dist/pocketbase.umd.js"></script>
</head>
<body>
  <h1>It works</h1>
  <p>Your PocketBase backend is available at <code>/api</code>.</p>
  <script>
    // The SDK talks to the same origin that serves this page.
    const pb = new PocketBase(window.location.origin)
    console.log("PocketBase health:", pb.health.check ? "sdk ready" : "sdk missing")
  </script>
</body>
</html>
`

// A starter migration that defines an example "notes" collection so the LLM
// has a working template to copy. PocketBase applies pb_migrations on boot.
const STARTER_MIGRATION = `/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = new Collection({
    type: "base",
    name: "notes",
    fields: [
      { name: "title", type: "text", required: true },
      { name: "body", type: "text" },
    ],
  })
  app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("notes")
  app.delete(collection)
})
`

// A guide dropped into the project so an AI assistant understands how to run,
// deploy, and add storage to a pocket. Kept intentionally short and practical.
const CLAUDE_LOCAL = `# siteio pocket — project guide (for the AI assistant)

This folder is a **siteio pocket**: a static website that ships with its own
backend (**PocketBase** — database, auth, file storage, REST + realtime API).
You edit the files here; the \`siteio\` CLI runs and deploys them.

## Commands

- \`siteio pocket dev\` — run locally, **no Docker**. Serves this folder plus the
  backend API at http://127.0.0.1:8090. Use this to test changes.
- \`siteio pocket deploy\` — deploy live in one command. Ships your code only;
  the server database (\`pb_data\`) is preserved across deploys.
- \`siteio pocket info\` — show the live URL, status, and version.
- \`siteio pocket logs\` — view backend logs.
- \`siteio pocket admin\` — print the admin dashboard URL (\`/_/\`) and superuser login.
- \`siteio pocket list\` / \`siteio pocket rm\` — list / remove pockets.

## Layout

- \`index.html\` (and any other files at the folder root) = the website, served as-is.
- \`.siteio/pb_migrations/*.js\` = your database schema, **as code**. Applied
  automatically on \`dev\` and \`deploy\`. See \`1700000000_init.js\` for the pattern.
- \`.siteio/pb_hooks/*.js\` = optional backend JS hooks.
- \`.siteio/pb_data/\` = local database (git-ignored, never deployed; production
  data lives on the server).

## IMPORTANT: if the site needs storage, auth, or a database — use the PocketBase JS client

Do NOT write a custom server. The backend already exists at \`/api\`. Load the
PocketBase SDK in the browser and talk to it directly:

\`\`\`html
<script src="https://cdn.jsdelivr.net/npm/pocketbase@0.22.0/dist/pocketbase.umd.js"></script>
<script>
  const pb = new PocketBase(window.location.origin)

  // Records (define the collection in a migration first)
  await pb.collection("notes").create({ title: "Hi", body: "..." })
  const page = await pb.collection("notes").getList(1, 50, { sort: "-created" })

  // Auth (built-in \`users\` collection)
  await pb.collection("users").create({ email, password, passwordConfirm: password })
  await pb.collection("users").authWithPassword(email, password)

  // Realtime — react to changes live
  pb.collection("notes").subscribe("*", (e) => console.log(e.action, e.record))

  // Files: append a File to a FormData and pass it to .create()/.update().
</script>
\`\`\`

## Defining data (schema)

Add or change a collection by writing a migration in \`.siteio/pb_migrations/\`,
then run \`siteio pocket dev\` (or \`deploy\`) — it applies automatically. Control
access with the collection's **API rules** in the migration:
\`""\` = public, \`"@request.auth.id != ''"\` = logged-in only, \`null\` = admin only.

## Docs

PocketBase: https://pocketbase.io/docs · JS SDK: https://github.com/pocketbase/js-sdk
`

function ensureGitignoreEntry(dir: string, entry: string): void {
  const path = join(dir, ".gitignore")
  if (!existsSync(path)) {
    writeFileSync(path, entry + "\n")
    return
  }
  const current = readFileSync(path, "utf-8")
  if (!current.split(/\r?\n/).includes(entry)) {
    appendFileSync(path, (current.endsWith("\n") ? "" : "\n") + entry + "\n")
  }
}

export function scaffoldPocket(dir: string): { created: string[] } {
  const created: string[] = []
  const write = (rel: string, content: string) => {
    const full = join(dir, rel)
    if (existsSync(full)) return
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, content)
    created.push(rel)
  }

  mkdirSync(join(dir, ".siteio", "pb_migrations"), { recursive: true })
  mkdirSync(join(dir, ".siteio", "pb_hooks"), { recursive: true })

  write("index.html", STARTER_INDEX)
  write("CLAUDE.local.md", CLAUDE_LOCAL)
  write(join(".siteio", "pb_migrations", "1700000000_init.js"), STARTER_MIGRATION)
  write(join(".siteio", "pb_hooks", ".gitkeep"), "")

  ensureGitignoreEntry(dir, ".siteio/pb_data/")

  return { created }
}
