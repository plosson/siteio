// Ambient declaration for *.css text imports used by src/lib/agent/ui/assets.ts.
// bun-types already declares *.html (HTMLBundle) and *.js (module), but not
// *.css. At runtime Bun's `with { type: "text" }` import attribute yields the
// file contents as a string.

declare module "*.css" {
  const content: string
  export default content
}
