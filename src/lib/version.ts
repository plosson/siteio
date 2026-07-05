import { readFileSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"

// BUILD_VERSION is injected at compile time via --define
declare const BUILD_VERSION: string | undefined

const __dirname = dirname(fileURLToPath(import.meta.url))

export function getVersion(): string {
  // Use build-time version if available (compiled binary)
  if (typeof BUILD_VERSION !== "undefined") {
    return BUILD_VERSION
  }
  // Fall back to package.json (development)
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"))
    return pkg.version
  } catch {
    return "0.0.0"
  }
}
