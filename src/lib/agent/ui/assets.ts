import indexHtml from "./index.html" with { type: "text" }
import appJs from "./app.js" with { type: "text" }
import appCss from "./app.css" with { type: "text" }

// Bun's `with { type: "text" }` import attribute yields the file contents as a
// string at runtime, but TypeScript's built-in module types (and bun-types'
// declarations for *.html / *.js) don't model that. Cast here so callers get
// `string` statically.
export const ADMIN_UI_HTML = indexHtml as unknown as string
export const ADMIN_UI_JS = appJs as unknown as string
export const ADMIN_UI_CSS = appCss as unknown as string
