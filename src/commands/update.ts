import chalk from "chalk"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { formatSuccess, formatError } from "../utils/output.ts"

// BUILD_VERSION is injected at compile time via --define
declare const BUILD_VERSION: string | undefined

const GITHUB_REPO = "plosson/siteio"

interface GitHubRelease {
  tag_name: string
  assets: Array<{
    name: string
    browser_download_url: string
  }>
}

function getCurrentVersion(): string {
  // Use build-time version if available (compiled binary)
  if (typeof BUILD_VERSION !== "undefined") {
    return BUILD_VERSION
  }

  // Fallback: try to read from package.json (development)
  try {
    const pkgPath = path.join(path.dirname(process.execPath), "../package.json")
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
      return pkg.version
    }
  } catch {
    // Ignore
  }

  return "0.0.0"
}

function getPlatform(): string {
  const platform = os.platform()
  const arch = os.arch()

  if (platform === "darwin") {
    return arch === "arm64" ? "darwin-arm64" : "darwin-x64"
  } else if (platform === "linux") {
    return arch === "arm64" ? "linux-arm64" : "linux-x64"
  } else if (platform === "win32") {
    return "windows-x64"
  }

  throw new Error(`Unsupported platform: ${platform}-${arch}`)
}

function getAssetName(platform: string): string {
  if (platform === "windows-x64") {
    return `siteio-${platform}.exe`
  }
  return `siteio-${platform}`
}

function getExecutablePath(): string {
  // For compiled binaries, process.execPath is the binary itself
  return process.execPath
}

async function fetchLatestRelease(): Promise<GitHubRelease> {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "siteio-updater",
    },
  })

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error("No releases found")
    }
    throw new Error(`Failed to fetch release info: ${response.statusText}`)
  }

  return response.json() as Promise<GitHubRelease>
}

function compareVersions(current: string, latest: string): number {
  const parseVersion = (v: string) =>
    v
      .replace(/^v/, "")
      .split(".")
      .map(Number)
  const currentParts = parseVersion(current)
  const latestParts = parseVersion(latest)

  for (let i = 0; i < 3; i++) {
    const c = currentParts[i] || 0
    const l = latestParts[i] || 0
    if (l > c) return 1
    if (l < c) return -1
  }
  return 0
}

async function downloadBinary(url: string, dest: string): Promise<void> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "siteio-updater",
    },
  })

  if (!response.ok) {
    throw new Error(`Download failed: ${response.statusText}`)
  }

  const buffer = await response.arrayBuffer()
  fs.writeFileSync(dest, Buffer.from(buffer))
}

function moveFile(src: string, dest: string): void {
  try {
    fs.renameSync(src, dest)
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "EXDEV") {
      fs.copyFileSync(src, dest)
      fs.unlinkSync(src)
    } else {
      throw err
    }
  }
}

async function updateBinary(downloadUrl: string, targetPath: string): Promise<void> {
  const platform = os.platform()
  const isWindows = platform === "win32"

  const targetDir = path.dirname(targetPath)
  const ext = isWindows ? ".exe" : ""
  const tmpFile = path.join(targetDir, `.siteio-update-${Date.now()}${ext}`)

  console.log("Downloading update...")
  await downloadBinary(downloadUrl, tmpFile)

  const stats = fs.statSync(tmpFile)
  if (stats.size === 0) {
    fs.unlinkSync(tmpFile)
    throw new Error("Downloaded file is empty")
  }

  let originalMode = 0o755
  try {
    originalMode = fs.statSync(targetPath).mode
  } catch {
    // Use default
  }

  console.log("Installing update...")

  if (isWindows) {
    const backupPath = targetPath + ".old"
    try {
      try {
        if (fs.existsSync(backupPath)) {
          fs.unlinkSync(backupPath)
        }
      } catch {
        const oldBackup = targetPath + ".old2"
        try {
          if (fs.existsSync(oldBackup)) fs.unlinkSync(oldBackup)
          fs.renameSync(backupPath, oldBackup)
        } catch {
          // Proceed anyway
        }
      }

      fs.renameSync(targetPath, backupPath)
      moveFile(tmpFile, targetPath)

      try {
        fs.unlinkSync(backupPath)
      } catch {
        // Expected on Windows
      }
    } catch (error) {
      try {
        if (fs.existsSync(backupPath) && !fs.existsSync(targetPath)) {
          fs.renameSync(backupPath, targetPath)
        }
        if (fs.existsSync(tmpFile)) {
          fs.unlinkSync(tmpFile)
        }
      } catch {
        // Best effort
      }
      throw error
    }
  } else {
    fs.chmodSync(tmpFile, originalMode)
    moveFile(tmpFile, targetPath)
  }
}

export interface UpdateOptions {
  check?: boolean
  force?: boolean
  yes?: boolean
}

export async function updateCommand(options: UpdateOptions = {}): Promise<void> {
  try {
    const currentVersion = getCurrentVersion()
    const platform = getPlatform()
    const assetName = getAssetName(platform)

    console.log(`Current version: ${currentVersion}`)
    console.log(`Platform: ${platform}`)
    console.log("")
    console.log("Checking for updates...")

    const release = await fetchLatestRelease()
    const latestVersion = release.tag_name.replace(/^v/, "")

    const comparison = compareVersions(currentVersion, latestVersion)

    if (comparison === 0 && !options.force) {
      console.log(formatSuccess(`Already on the latest version (${currentVersion})`))
      return
    }

    if (comparison < 0) {
      console.log(`Current version (${currentVersion}) is newer than latest release (${latestVersion})`)
      if (!options.force) {
        return
      }
    }

    console.log(chalk.green(`New version available: ${latestVersion}`))

    if (options.check) {
      return
    }

    const asset = release.assets.find((a) => a.name === assetName)
    if (!asset) {
      console.error(formatError(`No binary found for ${platform}`))
      console.error(chalk.gray(`Available assets: ${release.assets.map((a) => a.name).join(", ")}`))
      process.exit(1)
    }

    // Confirm update
    if (!options.yes) {
      const readline = await import("readline")
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      })

      const answer = await new Promise<string>((resolve) => {
        rl.question(`Update from ${currentVersion} to ${latestVersion}? [y/N] `, resolve)
      })
      rl.close()

      if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
        console.log("Update cancelled")
        return
      }
    }

    try {
      const execPath = getExecutablePath()
      await updateBinary(asset.browser_download_url, execPath)
      console.log(formatSuccess(`Updated to version ${latestVersion}`))
    } catch (error) {
      console.error("")
      console.error("Automatic update failed. You can update manually:")
      console.error("")
      if (os.platform() === "win32") {
        console.error("  iwr -useb https://siteio.me/install.ps1 | iex")
      } else {
        console.error("  curl -LsSf https://siteio.me/install | sh")
      }
      console.error("")
      throw error
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error(formatError(message))
    process.exit(1)
  }
}
