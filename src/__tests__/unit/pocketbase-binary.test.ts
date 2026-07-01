import { describe, test, expect } from "bun:test"
import {
  pocketbaseAssetName,
  pocketbaseDownloadUrl,
  pocketbaseCachePath,
} from "../../lib/pocketbase-binary.ts"

describe("Unit: pocketbase binary resolution", () => {
  test("asset name maps macOS arm64", () => {
    expect(pocketbaseAssetName("0.23.4", "darwin", "arm64")).toBe("pocketbase_0.23.4_darwin_arm64.zip")
  })
  test("asset name maps linux x64 to amd64", () => {
    expect(pocketbaseAssetName("0.23.4", "linux", "x64")).toBe("pocketbase_0.23.4_linux_amd64.zip")
  })
  test("asset name maps windows", () => {
    expect(pocketbaseAssetName("0.23.4", "win32", "x64")).toBe("pocketbase_0.23.4_windows_amd64.zip")
  })
  test("download url points at the pinned github release", () => {
    expect(pocketbaseDownloadUrl("0.23.4", "linux", "arm64")).toBe(
      "https://github.com/pocketbase/pocketbase/releases/download/v0.23.4/pocketbase_0.23.4_linux_arm64.zip"
    )
  })
  test("cache path is versioned and uses .exe on windows", () => {
    expect(pocketbaseCachePath("0.23.4", "win32").endsWith("pocketbase-0.23.4/pocketbase.exe")).toBe(true)
    expect(pocketbaseCachePath("0.23.4", "linux").endsWith("pocketbase-0.23.4/pocketbase")).toBe(true)
  })
})
