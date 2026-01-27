import * as p from "@clack/prompts"
import chalk from "chalk"
import { existsSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { spawnSync } from "bun"
import { randomBytes } from "crypto"
import { formatSuccess, formatError } from "../../utils/output.ts"
import { encodeToken } from "../../utils/token.ts"

const SERVICE_NAME = "siteio-agent"
const SERVICE_FILE = `/etc/systemd/system/${SERVICE_NAME}.service`

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

export async function installAgentCommand(): Promise<void> {
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

  // Gather configuration
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
          initialValue: "/data",
          validate: (value) => {
            if (!value) return "Data directory is required"
          },
        }),
      email: () =>
        p.text({
          message: "Email for Let's Encrypt (optional):",
          placeholder: "admin@example.com",
        }),
    },
    {
      onCancel: () => {
        p.cancel("Installation cancelled")
        process.exit(0)
      },
    }
  )

  const domain = answers.domain as string
  const dataDir = answers.dataDir as string
  const email = answers.email as string | undefined
  const apiKey = generateApiKey()

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
  const configContent = JSON.stringify({ apiKey, domain }, null, 2)

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
