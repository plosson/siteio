import * as p from "@clack/prompts"
import chalk from "chalk"
import { existsSync, writeFileSync } from "fs"
import { join } from "path"
import { spawnSync } from "bun"
import { randomBytes } from "crypto"
import { formatSuccess, formatError, formatWarning } from "../../utils/output.ts"
import { encodeToken } from "../../utils/token.ts"
import { isRemoteTarget, sshExec, sshExecStream } from "../../utils/ssh.ts"
import { setupWildcardDNS, CloudflareError } from "../../lib/cloudflare.ts"
import { waitForDNS, waitForCertificate } from "../../lib/verification.ts"

const SERVICE_NAME = "siteio-agent"
const SERVICE_FILE = `/etc/systemd/system/${SERVICE_NAME}.service`
const INSTALL_SCRIPT_URL = "https://siteio.me/install"

interface InstallOptions {
  domain?: string
  dataDir?: string
  email?: string
  identity?: string
  cloudflareToken?: string
}

function findBinaryPath(): string {
  const candidates = [
    "/usr/local/bin/siteio",
    join(process.env.HOME || "", ".local/bin/siteio"),
    process.argv[1],
  ]

  for (const path of candidates) {
    if (path && existsSync(path)) {
      const result = spawnSync({ cmd: ["realpath", path], stdout: "pipe", stderr: "pipe" })
      if (result.exitCode === 0) {
        return result.stdout.toString().trim()
      }
      return path
    }
  }

  throw new Error("Could not find siteio binary")
}

function generateApiKey(): string {
  return randomBytes(32).toString("hex")
}

function generateServiceFile(binaryPath: string, dataDir: string, domain: string, apiKey: string, email?: string): string {
  const envLines = [
    `Environment=SITEIO_DOMAIN=${domain}`,
    `Environment=SITEIO_API_KEY=${apiKey}`,
    `Environment=SITEIO_DATA_DIR=${dataDir}`,
  ]

  if (email) {
    envLines.push(`Environment=SITEIO_EMAIL=${email}`)
  }

  return `[Unit]
Description=siteio agent - static site deployment server
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
ExecStart=${binaryPath} agent start
Restart=always
RestartSec=5
${envLines.join("\n")}

[Install]
WantedBy=multi-user.target
`
}

async function installRemote(target: string, options: InstallOptions): Promise<void> {
  p.intro(chalk.bgCyan(" siteio agent install (remote) "))

  const s = p.spinner()

  // Test SSH connection
  s.start(`Testing SSH connection to ${target}`)
  const testResult = await sshExec(target, "echo ok", options.identity)
  if (testResult.exitCode !== 0) {
    s.stop(chalk.red("Failed"))
    console.error(formatError(`Could not connect to ${target}: ${testResult.stderr}`))
    process.exit(1)
  }
  s.stop(chalk.green("SSH connection OK"))

  // Gather configuration if not provided via flags
  let domain = options.domain
  let dataDir = options.dataDir || "/data"
  let email = options.email
  let cloudflareToken = options.cloudflareToken

  if (!domain) {
    const answers = await p.group(
      {
        domain: () =>
          p.text({
            message: "Domain for this agent:",
            placeholder: "example.siteio.me",
            validate: (value) => {
              if (!value) return "Domain is required"
              if (!value.includes(".")) return "Please enter a valid domain"
            },
          }),
        dataDir: () =>
          p.text({
            message: "Data directory:",
            initialValue: dataDir,
            validate: (value) => {
              if (!value) return "Data directory is required"
            },
          }),
        email: () =>
          p.text({
            message: "Email for Let's Encrypt:",
            placeholder: "you@example.com",
            validate: (value) => {
              if (!value) return "Email is required for Let's Encrypt certificates"
              if (!value.includes("@") || value.includes("example.com")) {
                return "Please enter a valid email address"
              }
            },
          }),
        cloudflareToken: () =>
          p.password({
            message: "Cloudflare API token (optional, for auto DNS setup):",
          }),
      },
      {
        onCancel: () => {
          p.cancel("Installation cancelled")
          process.exit(0)
        },
      }
    )

    domain = answers.domain as string
    dataDir = answers.dataDir as string
    email = answers.email as string | undefined
    cloudflareToken = answers.cloudflareToken as string | undefined
  }

  // Check if siteio is already installed
  s.start("Checking if siteio is installed on remote")
  const checkResult = await sshExec(target, "which siteio || echo 'not-found'", options.identity)
  const siteioInstalled = !checkResult.stdout.includes("not-found")
  s.stop(siteioInstalled ? chalk.green("siteio found") : chalk.yellow("siteio not found"))

  // Install siteio if needed
  if (!siteioInstalled) {
    console.log(chalk.cyan("\nInstalling siteio on remote server..."))
    const installCode = await sshExecStream(
      target,
      `curl -LsSf ${INSTALL_SCRIPT_URL} | sh`,
      options.identity
    )
    if (installCode !== 0) {
      console.error(formatError("Failed to install siteio on remote server"))
      process.exit(1)
    }
    console.log(chalk.green("siteio installed successfully\n"))
  }

  // Build the remote install command with flags
  // Use full path since PATH update from .bashrc hasn't taken effect yet
  const sitioBin = siteioInstalled ? "siteio" : "$HOME/.local/bin/siteio"
  let remoteCmd = `${sitioBin} agent install`
  remoteCmd += ` --domain ${domain}`
  remoteCmd += ` --data-dir ${dataDir}`
  if (email) {
    remoteCmd += ` --email ${email}`
  }
  if (cloudflareToken) {
    remoteCmd += ` --cloudflare-token ${cloudflareToken}`
  }

  // Run remote install
  console.log(chalk.cyan("Running agent install on remote server..."))
  const installCode = await sshExecStream(target, remoteCmd, options.identity)

  if (installCode !== 0) {
    console.error(formatError("Remote agent installation failed"))
    process.exit(1)
  }

  console.log("")
  p.outro(chalk.green("Remote installation complete!"))
}

async function installLocal(options: InstallOptions): Promise<void> {
  p.intro(chalk.bgCyan(" siteio agent install "))

  // Check if running as root or with sudo capability
  const whoami = spawnSync({ cmd: ["whoami"], stdout: "pipe" })
  const isRoot = whoami.stdout.toString().trim() === "root"

  if (!isRoot) {
    // Check if sudo is available
    const sudoCheck = spawnSync({ cmd: ["sudo", "-n", "true"], stdout: "pipe", stderr: "pipe" })
    if (sudoCheck.exitCode !== 0) {
      console.log(chalk.yellow("This command requires sudo privileges."))
    }
  }

  // Find binary
  let binaryPath: string
  try {
    binaryPath = findBinaryPath()
  } catch {
    console.error(formatError("Could not find siteio binary"))
    process.exit(1)
  }

  // Check Docker is available
  const dockerCheck = spawnSync({ cmd: ["docker", "info"], stdout: "pipe", stderr: "pipe" })
  if (dockerCheck.exitCode !== 0) {
    console.error(formatError("Docker is not available. Please install Docker first."))
    process.exit(1)
  }

  // Gather configuration - use flags if provided, otherwise prompt
  let domain = options.domain
  let dataDir = options.dataDir || "/data"
  let email = options.email
  let cloudflareToken = options.cloudflareToken

  if (!domain) {
    // Interactive mode - prompt for configuration
    const answers = await p.group(
      {
        domain: () =>
          p.text({
            message: "Domain for this agent:",
            placeholder: "example.siteio.me",
            validate: (value) => {
              if (!value) return "Domain is required"
              if (!value.includes(".")) return "Please enter a valid domain"
            },
          }),
        dataDir: () =>
          p.text({
            message: "Data directory:",
            initialValue: dataDir,
            validate: (value) => {
              if (!value) return "Data directory is required"
            },
          }),
        email: () =>
          p.text({
            message: "Email for Let's Encrypt:",
            placeholder: "you@example.com",
            validate: (value) => {
              if (!value) return "Email is required for Let's Encrypt certificates"
              if (!value.includes("@") || value.includes("example.com")) {
                return "Please enter a valid email address"
              }
            },
          }),
        cloudflareToken: () =>
          p.password({
            message: "Cloudflare API token (optional, for auto DNS setup):",
          }),
      },
      {
        onCancel: () => {
          p.cancel("Installation cancelled")
          process.exit(0)
        },
      }
    )

    domain = answers.domain as string
    dataDir = answers.dataDir as string
    email = answers.email as string | undefined
    cloudflareToken = answers.cloudflareToken as string | undefined
  }

  const apiKey = generateApiKey()

  // Setup Cloudflare DNS if token provided
  if (cloudflareToken) {
    const s = p.spinner()
    s.start("Setting up Cloudflare DNS")
    try {
      const result = await setupWildcardDNS(cloudflareToken, domain)
      if (result.skipped) {
        s.stop(chalk.yellow("Skipped"))
        console.log(formatWarning(result.message))
      } else {
        s.stop(chalk.green("Done"))
        console.log(formatSuccess(result.message))
      }
    } catch (error) {
      s.stop(chalk.yellow("Skipped"))
      const message = error instanceof CloudflareError ? error.message : String(error)
      console.log(formatWarning(`Could not set up DNS: ${message}. Please configure manually.`))
    }
  }

  // Create data directory
  const s = p.spinner()
  s.start("Creating data directory")

  const mkdirResult = spawnSync({
    cmd: isRoot
      ? ["mkdir", "-p", dataDir]
      : ["sudo", "mkdir", "-p", dataDir],
    stdout: "pipe",
    stderr: "pipe",
  })

  if (mkdirResult.exitCode !== 0) {
    s.stop(chalk.red("Failed"))
    console.error(formatError(`Could not create data directory: ${mkdirResult.stderr.toString()}`))
    process.exit(1)
  }
  s.stop(chalk.green("Data directory created"))

  // Save agent config
  s.start("Saving configuration")
  const configPath = join(dataDir, "agent-config.json")
  const configData: Record<string, string> = { apiKey, domain }
  if (cloudflareToken) {
    configData.cloudflareToken = cloudflareToken
  }
  const configContent = JSON.stringify(configData, null, 2)

  const writeConfigCmd = isRoot
    ? ["sh", "-c", `echo '${configContent}' > ${configPath}`]
    : ["sudo", "sh", "-c", `echo '${configContent}' > ${configPath}`]

  spawnSync({ cmd: writeConfigCmd, stdout: "pipe", stderr: "pipe" })
  s.stop(chalk.green("Configuration saved"))

  // Generate and write service file
  s.start("Creating systemd service")
  const serviceContent = generateServiceFile(binaryPath, dataDir, domain, apiKey, email)

  const tempFile = `/tmp/${SERVICE_NAME}.service`
  writeFileSync(tempFile, serviceContent)

  const copyResult = spawnSync({
    cmd: isRoot
      ? ["cp", tempFile, SERVICE_FILE]
      : ["sudo", "cp", tempFile, SERVICE_FILE],
    stdout: "pipe",
    stderr: "pipe",
  })

  if (copyResult.exitCode !== 0) {
    s.stop(chalk.red("Failed"))
    console.error(formatError(`Could not create service file: ${copyResult.stderr.toString()}`))
    process.exit(1)
  }
  s.stop(chalk.green("Systemd service created"))

  // Reload systemd and enable service
  s.start("Enabling service")
  const commands = [
    ["systemctl", "daemon-reload"],
    ["systemctl", "enable", SERVICE_NAME],
  ]

  for (const cmd of commands) {
    const result = spawnSync({
      cmd: isRoot ? cmd : ["sudo", ...cmd],
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) {
      s.stop(chalk.red("Failed"))
      console.error(formatError(`Command failed: ${cmd.join(" ")}`))
      process.exit(1)
    }
  }
  s.stop(chalk.green("Service enabled"))

  // Start the service
  s.start("Starting agent")
  const startResult = spawnSync({
    cmd: isRoot
      ? ["systemctl", "start", SERVICE_NAME]
      : ["sudo", "systemctl", "start", SERVICE_NAME],
    stdout: "pipe",
    stderr: "pipe",
  })

  if (startResult.exitCode !== 0) {
    s.stop(chalk.red("Failed"))
    console.error(formatError(`Could not start service: ${startResult.stderr.toString()}`))
    process.exit(1)
  }

  // Wait a moment and check status
  await new Promise((resolve) => setTimeout(resolve, 2000))

  const statusResult = spawnSync({
    cmd: ["systemctl", "is-active", SERVICE_NAME],
    stdout: "pipe",
    stderr: "pipe",
  })

  if (statusResult.stdout.toString().trim() !== "active") {
    s.stop(chalk.red("Failed"))
    console.error(formatError("Service failed to start. Check logs with: journalctl -u siteio-agent"))
    process.exit(1)
  }

  s.stop(chalk.green("Agent started"))

  // Verify DNS propagation and certificate (only when Cloudflare was used)
  if (cloudflareToken) {
    const apiDomain = `api.${domain}`

    // DNS verification
    s.start("Waiting for DNS propagation")
    const dnsResult = await waitForDNS(apiDomain, { maxAttempts: 5 }, (attempt, max) => {
      if (attempt > 1) {
        s.message(`Waiting for DNS propagation (attempt ${attempt}/${max})`)
      }
    })

    if (dnsResult.success) {
      s.stop(chalk.green("DNS verified"))

      // Certificate verification (only if DNS succeeded)
      s.start("Waiting for HTTPS certificate")
      const certResult = await waitForCertificate(apiDomain, { maxAttempts: 5 }, (attempt, max) => {
        if (attempt > 1) {
          s.message(`Waiting for HTTPS certificate (attempt ${attempt}/${max})`)
        }
      })

      if (certResult.success) {
        s.stop(chalk.green("Certificate ready"))
      } else {
        s.stop(chalk.yellow("Certificate pending"))
        console.log(formatWarning("HTTPS certificate may take a moment to become available."))
      }
    } else {
      s.stop(chalk.yellow("DNS verification timed out"))
      console.log(formatWarning("DNS may still be propagating. HTTPS may take a minute to become available."))
    }
  }

  // Generate connection info
  const apiUrl = `https://api.${domain}`
  const token = encodeToken(apiUrl, apiKey)

  console.log("")
  console.log(formatSuccess("siteio agent installed and running!"))
  console.log("")
  console.log(chalk.cyan.bold("─── Connection Credentials ───"))
  console.log("")
  console.log(`  URL:     ${apiUrl}`)
  console.log(`  API Key: ${apiKey}`)
  console.log(`  Token:   ${token}`)
  console.log("")
  console.log(chalk.cyan.bold("──────────────────────────────"))
  console.log("")
  console.log(chalk.gray("Users can connect with:"))
  console.log(chalk.gray(`  siteio login -t ${token}`))
  console.log("")
  console.log(chalk.gray("Manage with:"))
  console.log(chalk.gray("  siteio agent status"))
  console.log(chalk.gray("  siteio agent stop"))
  console.log(chalk.gray("  siteio agent restart"))
  console.log("")

  p.outro(chalk.green("Installation complete!"))
}

export async function installAgentCommand(target?: string, options: InstallOptions = {}): Promise<void> {
  if (target && isRemoteTarget(target)) {
    await installRemote(target, options)
  } else {
    await installLocal(options)
  }
}
