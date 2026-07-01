import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "fs"
import { join } from "path"

const STARTER_INDEX = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>My Pocket</title>
  <script src="https://cdn.jsdelivr.net/npm/pocketbase@0.23.0/dist/pocketbase.umd.js"></script>
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
  write(join(".siteio", "pb_migrations", "1700000000_init.js"), STARTER_MIGRATION)
  write(join(".siteio", "pb_hooks", ".gitkeep"), "")

  ensureGitignoreEntry(dir, ".siteio/pb_data/")

  return { created }
}
