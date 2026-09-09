import chalk from "chalk"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { formatSuccess, formatError } from "../utils/output.ts"

// BUILD_VERSION is injected at compile time via --define
declare const BUILD_VERSION: string | undefined

const GITHUB_REPO = "plosson/siteio"
const USER_AGENT = "siteio-updater"

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

interface LatestRelease {
  tag: string
  // Populated only when the REST API answered; the redirect path knows the tag
  // but not the asset list.
  assets: GitHubRelease["assets"] | null
}

function githubAuthHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  return token ? { Authorization: `Bearer ${token}` } : {}
}

// github.com/<repo>/releases/latest redirects to /releases/tag/<tag>. This is not
// the REST API, so it does not consume the 60 requests/hour that api.github.com
// allows an unauthenticated IP - a budget other tools on the same machine (or
// behind the same NAT) can exhaust on their own.
async function fetchLatestTagViaRedirect(): Promise<string | null> {
  try {
    const response = await fetch(`https://github.com/${GITHUB_REPO}/releases/latest`, {
      method: "HEAD",
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT },
    })

    const location = response.headers.get("location")
    const match = location?.match(/\/releases\/tag\/([^/?#]+)$/)
    return match ? decodeURIComponent(match[1]!) : null
  } catch {
    return null
  }
}

async function fetchLatestRelease(): Promise<GitHubRelease> {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": USER_AGENT,
      ...githubAuthHeaders(),
    },
  })

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error("No releases found")
    }
    if (response.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(response.headers.get("x-ratelimit-reset") || 0)
      const minutes = reset ? Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 60000)) : 0
      throw new Error(
        `GitHub API rate limit exceeded${minutes ? ` (resets in ~${minutes} min)` : ""}. ` +
          "Set GITHUB_TOKEN (or GH_TOKEN) to raise the limit, or install manually with: " +
          "curl -LsSf https://siteio.houlahop.com/install | sh"
      )
    }
    throw new Error(`Failed to fetch release info: ${response.statusText}`)
  }

  return response.json() as Promise<GitHubRelease>
}

// Prefer the redirect; fall back to the REST API so a GitHub change to the
// redirect shape degrades to the old behaviour rather than breaking updates.
async function resolveLatestRelease(): Promise<LatestRelease> {
  const tag = await fetchLatestTagViaRedirect()
  if (tag) return { tag, assets: null }

  const release = await fetchLatestRelease()
  return { tag: release.tag_name, assets: release.assets }
}

// The redirect path never sees the asset list, so the download URL is built from
// the tag and probed with a HEAD to keep the "no binary for this platform" error.
async function resolveDownloadUrl(release: LatestRelease, assetName: string, platform: string): Promise<string> {
  if (release.assets) {
    const asset = release.assets.find((a) => a.name === assetName)
    if (!asset) {
      throw new Error(
        `No binary found for ${platform}. Available assets: ${release.assets.map((a) => a.name).join(", ")}`
      )
    }
    return asset.browser_download_url
  }

  const url = `https://github.com/${GITHUB_REPO}/releases/download/${release.tag}/${assetName}`
  const response = await fetch(url, { method: "HEAD", headers: { "User-Agent": USER_AGENT } })
  if (!response.ok) {
    throw new Error(`No binary found for ${platform} in release ${release.tag}. Expected asset: ${assetName}`)
  }
  return url
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

function renderProgress(received: number, total: number, done = false): void {
  const mb = (b: number) => (b / 1024 / 1024).toFixed(1)
  const width = 30
  let line: string
  if (total > 0) {
    const pct = Math.min(100, Math.floor((received / total) * 100))
    const filled = Math.floor((pct / 100) * width)
    const bar = "█".repeat(filled) + "░".repeat(width - filled)
    line = `  [${bar}] ${pct}% (${mb(received)}/${mb(total)} MB)`
  } else {
    line = `  Downloaded ${mb(received)} MB`
  }
  process.stderr.write(`\r\x1b[K${line}`)
  if (done) process.stderr.write("\n")
}

async function writeChunk(stream: fs.WriteStream, chunk: Uint8Array): Promise<void> {
  if (stream.write(chunk)) return
  await new Promise<void>((resolve) => stream.once("drain", resolve))
}

async function downloadBinary(url: string, dest: string): Promise<void> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
    },
  })

  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${response.statusText}`)
  }

  const total = Number(response.headers.get("content-length") || 0)
  let received = 0
  let lastRender = 0
  const showProgress = process.stderr.isTTY

  const file = fs.createWriteStream(dest)
  try {
    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      await writeChunk(file, value)
      received += value.length
      if (showProgress) {
        const now = Date.now()
        if (now - lastRender > 100) {
          renderProgress(received, total)
          lastRender = now
        }
      }
    }
    if (showProgress) renderProgress(received, total, true)
  } finally {
    await new Promise<void>((resolve, reject) => {
      file.end((err?: Error | null) => (err ? reject(err) : resolve()))
    })
  }
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

    const release = await resolveLatestRelease()
    const latestVersion = release.tag.replace(/^v/, "")

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

    const downloadUrl = await resolveDownloadUrl(release, assetName, platform)

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
      await updateBinary(downloadUrl, execPath)
      console.log(formatSuccess(`Updated to version ${latestVersion}`))
    } catch (error) {
      console.error("")
      console.error("Automatic update failed. You can update manually:")
      console.error("")
      if (os.platform() === "win32") {
        console.error("  Windows binaries are not shipped yet. Use macOS/Linux or WSL:")
        console.error("  curl -LsSf https://siteio.houlahop.com/install | sh")
      } else {
        console.error("  curl -LsSf https://siteio.houlahop.com/install | sh")
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
