import chalk from "chalk"
import { spawnSync } from "bun"
import { formatSuccess, formatError } from "../../utils/output.ts"

const SERVICE_NAME = "siteio-agent"

export async function restartAgentCommand(): Promise<void> {
  // Check if systemd service exists
  const checkResult = spawnSync({
    cmd: ["systemctl", "status", SERVICE_NAME],
    stdout: "pipe",
    stderr: "pipe",
  })

  if (checkResult.exitCode === 4) {
    console.error(formatError("siteio-agent service is not installed"))
    console.error(chalk.gray("  Run 'siteio agent install' first"))
    process.exit(1)
  }

  console.log(chalk.cyan("Restarting siteio agent..."))

  const result = spawnSync({
    cmd: ["sudo", "systemctl", "restart", SERVICE_NAME],
    stdout: "inherit",
    stderr: "inherit",
  })

  if (result.exitCode !== 0) {
    console.error(formatError("Failed to restart agent"))
    process.exit(1)
  }

  // Wait and verify
  await new Promise((resolve) => setTimeout(resolve, 2000))

  const statusResult = spawnSync({
    cmd: ["systemctl", "is-active", SERVICE_NAME],
    stdout: "pipe",
    stderr: "pipe",
  })

  if (statusResult.stdout.toString().trim() !== "active") {
    console.error(formatError("Agent failed to restart. Check logs with: journalctl -u siteio-agent"))
    process.exit(1)
  }

  console.log(formatSuccess("Agent restarted"))
}
