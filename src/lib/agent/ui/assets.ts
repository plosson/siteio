import indexHtml from "./index.html" with { type: "text" }
import appJs from "./ui.js" with { type: "text" }
import familyCss from "./family.css" with { type: "text" }
import brandCss from "./brand.css" with { type: "text" }
import appCss from "./ui.css" with { type: "text" }
import iconSvg from "./icon.svg" with { type: "text" }
import chatCoreJs from "./chat-core.js" with { type: "text" }
import editorHtml from "./editor.html" with { type: "text" }
import pickerJs from "./picker.js" with { type: "text" }

// Bun's `with { type: "text" }` import attribute yields the file contents as a
// string at runtime, but TypeScript's built-in module types (and bun-types'
// declarations for *.html / *.js) don't model that. Cast here so callers get
// `string` statically.
const text = (source: unknown): string => source as string

// The siteio icon as a data URI: the favicon and the sidebar lockup of the
// admin, and the mark of the in-site editor, with no request of its own. "'"
// is escaped too: the editor puts the URI inside a single-quoted JS string.
const ICON_URI = `data:image/svg+xml;utf8,${encodeURIComponent(text(iconSvg)).replace(/'/g, "%27")}`

export const ADMIN_UI_HTML = text(indexHtml).replaceAll("__ICON_URI__", () => ICON_URI)
export const ADMIN_UI_JS = text(appJs)
// The family tokens, then siteio's brand values (agentio's), then the admin's
// own rules: one stylesheet, served at /ui/ui.css.
export const ADMIN_UI_CSS = [familyCss, brandCss, appCss].map(text).join("\n")
// Shared SSE/chat transport, served to the admin panel and inlined into the
// in-site editor shell (which lives on a different host).
export const CHAT_CORE_JS = chatCoreJs as unknown as string
// In-site live editor shell. Served (with site name/URL + chat-core injected)
// at <site>.<domain>/_siteio/edit.
export const EDITOR_SHELL_HTML = text(editorHtml).replaceAll("__ICON_URI__", () => ICON_URI)
// In-frame element/text picker. In Phase 1 the shell injects this into the
// framed site's document on load; carried inside the shell as an inert
// text/plain block (see serveEditorShell) so there's no string-escaping.
export const PICKER_JS = pickerJs as unknown as string
