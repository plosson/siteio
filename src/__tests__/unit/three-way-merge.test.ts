import { describe, expect, test } from "bun:test"
import { mergeTrees, hasConflictMarkers, type FileTree } from "../../lib/agent/three-way-merge.ts"

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array | undefined) => (b === undefined ? undefined : new TextDecoder().decode(b))
const tree = (files: Record<string, string>): FileTree =>
  Object.fromEntries(Object.entries(files).map(([k, v]) => [k, enc(v)]))
const page = (title: string, footer: string) => `<h1>${title}</h1>\n<p>a</p>\n<p>b</p>\n<p>c</p>\n<footer>${footer}</footer>\n`

describe("mergeTrees", () => {
  test("edits to different lines of the same file are both kept", () => {
    const { files, conflicts } = mergeTrees(
      tree({ "index.html": page("Hello", "2025") }),
      tree({ "index.html": page("Bonjour", "2025") }),
      tree({ "index.html": page("Hello", "2026") }),
    )
    expect(conflicts).toEqual([])
    expect(dec(files["index.html"])).toBe(page("Bonjour", "2026"))
  })

  test("edits to the same line are a conflict with labelled markers, never a silent pick", () => {
    const { files, conflicts } = mergeTrees(
      tree({ "index.html": page("Hello", "2025") }),
      tree({ "index.html": page("Bonjour", "2025") }),
      tree({ "index.html": page("Hola", "2025") }),
    )
    expect(conflicts).toEqual([{ path: "index.html", reason: "both-edited" }])
    const text = dec(files["index.html"])!
    expect(text).toContain("<<<<<<< your edits\n<h1>Hola</h1>")
    expect(text).toContain("<h1>Bonjour</h1>\n>>>>>>> current site")
    expect(hasConflictMarkers(files["index.html"]!)).toBe(true)
  })

  test("files added, changed or deleted on one side only follow that side", () => {
    const { files, conflicts } = mergeTrees(
      tree({ "a.html": "a", "gone-on-site.html": "x", "gone-by-you.html": "y", "same.css": "s" }),
      tree({ "a.html": "a2", "gone-by-you.html": "y", "same.css": "s", "new-on-site.html": "n" }),
      tree({ "a.html": "a", "gone-on-site.html": "x", "same.css": "s", "new-by-you.html": "m" }),
    )
    expect(conflicts).toEqual([])
    expect(Object.keys(files).sort()).toEqual(["a.html", "new-by-you.html", "new-on-site.html", "same.css"])
    expect(dec(files["a.html"])).toBe("a2")
  })

  test("both sides making the identical change is not a conflict", () => {
    const { files, conflicts } = mergeTrees(tree({ "a": "1" }), tree({ "a": "2", "n": "x" }), tree({ "a": "2", "n": "x" }))
    expect(conflicts).toEqual([])
    expect(dec(files["a"])).toBe("2")
  })

  test("you deleted a file the site changed: conflict, the site's version is restored", () => {
    const { files, conflicts } = mergeTrees(tree({ "a": "1" }), tree({ "a": "2" }), tree({}))
    expect(conflicts).toEqual([{ path: "a", reason: "deleted-by-you" }])
    expect(dec(files["a"])).toBe("2")
  })

  test("the site deleted a file you changed: conflict, your version is kept", () => {
    const { files, conflicts } = mergeTrees(tree({ "a": "1" }), tree({}), tree({ "a": "mine" }))
    expect(conflicts).toEqual([{ path: "a", reason: "deleted-on-site" }])
    expect(dec(files["a"])).toBe("mine")
  })

  test("a binary file changed on both sides is a conflict and is never corrupted with markers", () => {
    const img = (n: number) => new Uint8Array([0x89, 0x50, 0, n])
    const { files, conflicts } = mergeTrees({ "logo.png": img(1) }, { "logo.png": img(2) }, { "logo.png": img(3) })
    expect(conflicts).toEqual([{ path: "logo.png", reason: "binary" }])
    expect(files["logo.png"]).toEqual(img(3))
    expect(hasConflictMarkers(files["logo.png"]!)).toBe(false)
  })

  test("with no base (pruned from history), differing files conflict and nothing is deleted", () => {
    const { files, conflicts } = mergeTrees(
      {},
      tree({ "index.html": page("Bonjour", "2025"), "site-only.html": "s" }),
      tree({ "index.html": page("Hello", "2026"), "mine-only.html": "m" }),
    )
    expect(conflicts).toEqual([{ path: "index.html", reason: "both-edited" }])
    expect(Object.keys(files).sort()).toEqual(["index.html", "mine-only.html", "site-only.html"])
  })

  test("paths that look like options or contain spaces are merged safely", () => {
    const { files, conflicts } = mergeTrees(
      tree({ "-p": page("Hello", "2025"), "my file.html": "x" }),
      tree({ "-p": page("Bonjour", "2025"), "my file.html": "x" }),
      tree({ "-p": page("Hello", "2026"), "my file.html": "y" }),
    )
    expect(conflicts).toEqual([])
    expect(dec(files["-p"])).toBe(page("Bonjour", "2026"))
    expect(dec(files["my file.html"])).toBe("y")
  })

  test("files without a trailing newline and CRLF files merge without damage", () => {
    const { files, conflicts } = mergeTrees(
      tree({ "a.txt": "one\r\ntwo\r\nthree\r\nfour\r\nfive" }),
      tree({ "a.txt": "ONE\r\ntwo\r\nthree\r\nfour\r\nfive" }),
      tree({ "a.txt": "one\r\ntwo\r\nthree\r\nfour\r\nFIVE" }),
    )
    expect(conflicts).toEqual([])
    expect(dec(files["a.txt"])).toBe("ONE\r\ntwo\r\nthree\r\nfour\r\nFIVE")
  })
})

describe("hasConflictMarkers", () => {
  test("ignores look-alike text that is not one of our marker lines", () => {
    expect(hasConflictMarkers(enc("<p><<<<<<< your edits</p>\n"))).toBe(false)
    expect(hasConflictMarkers(enc("<<<<<<< HEAD\nx\n>>>>>>> main\n"))).toBe(false)
    expect(hasConflictMarkers(enc("ok\n"))).toBe(false)
  })
})
