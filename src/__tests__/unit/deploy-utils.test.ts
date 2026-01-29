import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync, unzipSync } from "fflate"

// Test the collectFiles-like logic
async function collectFiles(dir: string, baseDir: string = dir): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {}
  const { readdirSync, statSync } = await import("fs")

  const entries = readdirSync(dir)
  for (const entry of entries) {
    const fullPath = join(dir, entry)
    const relativePath = fullPath.slice(baseDir.length + 1)
    const stat = statSync(fullPath)

    if (stat.isDirectory()) {
      const subFiles = await collectFiles(fullPath, baseDir)
      Object.assign(files, subFiles)
    } else {
      const content = await Bun.file(fullPath).bytes()
      files[relativePath] = content
    }
  }

  return files
}

describe("Unit: Deploy Utils", () => {
  let testDir: string

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), "siteio-deploy-test-"))

    // Create test file structure
    writeFileSync(join(testDir, "index.html"), "<html><body>Index</body></html>")
    writeFileSync(join(testDir, "about.html"), "<html><body>About</body></html>")
    mkdirSync(join(testDir, "css"))
    writeFileSync(join(testDir, "css", "style.css"), "body { margin: 0; }")
    mkdirSync(join(testDir, "js"))
    writeFileSync(join(testDir, "js", "app.js"), "console.log('hello')")
    mkdirSync(join(testDir, "images"))
    writeFileSync(join(testDir, "images", "logo.png"), "fake-png-data")
    mkdirSync(join(testDir, "nested", "deep", "folder"), { recursive: true })
    writeFileSync(join(testDir, "nested", "deep", "folder", "file.txt"), "deeply nested")
  })

  afterAll(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true })
    }
  })

  test("should collect all files from directory", async () => {
    const files = await collectFiles(testDir)

    expect(Object.keys(files).length).toBe(6)
    expect(files["index.html"]).toBeDefined()
    expect(files["about.html"]).toBeDefined()
    expect(files["css/style.css"]).toBeDefined()
    expect(files["js/app.js"]).toBeDefined()
    expect(files["images/logo.png"]).toBeDefined()
    expect(files["nested/deep/folder/file.txt"]).toBeDefined()
  })

  test("should create valid zip that can be extracted", async () => {
    const files = await collectFiles(testDir)
    const zipData = zipSync(files, { level: 6 })

    // Verify zip is valid
    expect(zipData.length).toBeGreaterThan(0)

    // Extract and verify
    const extracted = unzipSync(zipData)
    expect(Object.keys(extracted).length).toBe(6)

    // Verify content
    const indexContent = new TextDecoder().decode(extracted["index.html"])
    expect(indexContent).toBe("<html><body>Index</body></html>")

    const nestedContent = new TextDecoder().decode(extracted["nested/deep/folder/file.txt"])
    expect(nestedContent).toBe("deeply nested")
  })

  test("should handle empty directory gracefully", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "siteio-empty-"))
    try {
      const files = await collectFiles(emptyDir)
      expect(Object.keys(files).length).toBe(0)
    } finally {
      rmSync(emptyDir, { recursive: true })
    }
  })
})

describe("Subdomain sanitization", () => {
  function sanitizeSubdomain(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
  }

  test("should lowercase names", () => {
    expect(sanitizeSubdomain("MyProject")).toBe("myproject")
  })

  test("should replace spaces with hyphens", () => {
    expect(sanitizeSubdomain("my project")).toBe("my-project")
  })

  test("should replace special characters", () => {
    expect(sanitizeSubdomain("my_project.v2")).toBe("my-project-v2")
  })

  test("should collapse multiple hyphens", () => {
    expect(sanitizeSubdomain("my---project")).toBe("my-project")
  })

  test("should trim leading/trailing hyphens", () => {
    expect(sanitizeSubdomain("-my-project-")).toBe("my-project")
  })

  test("should handle complex names", () => {
    expect(sanitizeSubdomain("My Cool Project! (v2.0)")).toBe("my-cool-project-v2-0")
  })
})
