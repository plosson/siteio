import indexHtml from "./index.html" with { type: "text" }
import appJs from "./ui.js" with { type: "text" }
import appCss from "./ui.css" with { type: "text" }
import chatCoreJs from "./chat-core.js" with { type: "text" }
import editorHtml from "./editor.html" with { type: "text" }

// Bun's `with { type: "text" }` import attribute yields the file contents as a
// string at runtime, but TypeScript's built-in module types (and bun-types'
// declarations for *.html / *.js) don't model that. Cast here so callers get
// `string` statically.
export const ADMIN_UI_HTML = indexHtml as unknown as string
export const ADMIN_UI_JS = appJs as unknown as string
export const ADMIN_UI_CSS = appCss as unknown as string
// Shared SSE/chat transport, served to the admin panel and inlined into the
// in-site editor shell (which lives on a different host).
export const CHAT_CORE_JS = chatCoreJs as unknown as string
// In-site live editor shell. Served (with site name/URL + chat-core injected)
// at <site>.<domain>/_siteio/edit.
export const EDITOR_SHELL_HTML = editorHtml as unknown as string
