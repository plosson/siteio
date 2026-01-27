import chalk from "chalk"
import { spawnSync } from "bun"
import { formatSuccess, formatError } from "../../utils/output.ts"

const SERVICE_NAME = "siteio-agent"

export async function stopAgentCommand(): Promise<void> {
  // Check if systemd service exists
  const checkResult = spawnSync({
    cmd: ["systemctl", "status", SERVICE_NAME],
    stdout: "pipe",
    stderr: "pipe",
  })

  if (checkResult.exitCode === 4) {
    // Service doesn't exist
    console.error(formatError("siteio-agent service is not installed"))
    console.error(chalk.gray("  Run 'siteio agent install' first"))
    process.exit(1)
  }

  console.log(chalk.cyan("Stopping siteio agent..."))

  const result = spawnSync({
    cmd: ["sudo", "systemctl", "stop", SERVICE_NAME],
    stdout: "inherit",
    stderr: "inherit",
  })

  if (result.exitCode !== 0) {
    console.error(formatError("Failed to stop agent"))
    process.exit(1)
  }

  console.log(formatSuccess("Agent stopped"))
}
