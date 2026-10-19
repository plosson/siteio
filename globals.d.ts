// Ambient declarations for the *.css and *.svg text imports used by src/lib/agent/ui/assets.ts.
// bun-types already declares *.html (HTMLBundle) and *.js (module), but not
// *.css. At runtime Bun's `with { type: "text" }` import attribute yields the
// file contents as a string.

declare module "*.css" {
  const content: string
  export default content
}

// The siteio icon (src/lib/agent/ui/icon.svg), imported as text the same way.
declare module "*.svg" {
  const content: string
  export default content
}
