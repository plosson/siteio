import chalk from "chalk"
import { spawnSync } from "bun"
import { formatError } from "../../utils/output.ts"

const SERVICE_NAME = "siteio-agent"
const TRAEFIK_CONTAINER = "siteio-traefik"

export async function statusAgentCommand(): Promise<void> {
  console.log(chalk.cyan("siteio agent status"))
  console.log("")

  // Check systemd service status
  const serviceResult = spawnSync({
    cmd: ["systemctl", "is-active", SERVICE_NAME],
    stdout: "pipe",
    stderr: "pipe",
  })

  const serviceStatus = serviceResult.stdout.toString().trim()
  const serviceRunning = serviceStatus === "active"

  // Check if service exists
  const existsResult = spawnSync({
    cmd: ["systemctl", "status", SERVICE_NAME],
    stdout: "pipe",
    stderr: "pipe",
  })
  const serviceExists = existsResult.exitCode !== 4

  // Check Traefik container
  const traefikResult = spawnSync({
    cmd: ["docker", "inspect", "-f", "{{.State.Status}}", TRAEFIK_CONTAINER],
    stdout: "pipe",
    stderr: "pipe",
  })
  const traefikStatus = traefikResult.exitCode === 0 ? traefikResult.stdout.toString().trim() : "not found"
  const traefikRunning = traefikStatus === "running"

  // Display status
  if (!serviceExists) {
    console.log(`  Agent:   ${chalk.gray("not installed")}`)
    console.log(`  Traefik: ${traefikRunning ? chalk.green("running") : chalk.gray(traefikStatus)}`)
    console.log("")
    console.error(formatError("Service not installed. Run 'siteio agent install' first"))
    process.exit(1)
  }

  console.log(`  Agent:   ${serviceRunning ? chalk.green("running") : chalk.yellow(serviceStatus)}`)
  console.log(`  Traefik: ${traefikRunning ? chalk.green("running") : chalk.yellow(traefikStatus)}`)

  // Show recent logs if running
  if (serviceRunning) {
    console.log("")
    console.log(chalk.gray("Recent logs:"))
    const logsResult = spawnSync({
      cmd: ["journalctl", "-u", SERVICE_NAME, "-n", "5", "--no-pager", "-o", "cat"],
      stdout: "pipe",
      stderr: "pipe",
    })
    const logs = logsResult.stdout.toString().trim()
    if (logs) {
      console.log(chalk.gray(logs.split("\n").map(l => `  ${l}`).join("\n")))
    }
  }

  // Exit with error if not running
  if (!serviceRunning) {
    process.exit(1)
  }
}
