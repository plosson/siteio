import * as p from "@clack/prompts"
import chalk from "chalk"
import { existsSync } from "fs"
import { spawnSync } from "bun"
import { formatSuccess, formatError, formatWarning } from "../../utils/output.ts"
import { loadAgentConfig } from "../../config/agent.ts"
import { isRemoteTarget, sshExec, sshExecStream } from "../../utils/ssh.ts"
import { removeWildcardDNS, CloudflareError } from "../../lib/cloudflare.ts"

const SERVICE_NAME = "siteio-agent"
const SERVICE_FILE = `/etc/systemd/system/${SERVICE_NAME}.service`
const DEFAULT_DATA_DIR = "/data"
const CONTAINER_PREFIX = "siteio-"

interface UninstallOptions {
  removeData?: boolean
  removeContainers?: boolean
  yes?: boolean
  identity?: string
}

function listSiteioContainers(): string[] {
  const result = spawnSync({
    cmd: ["docker", "ps", "-a", "--filter", `name=${CONTAINER_PREFIX}`, "--format", "{{.Names}}"],
    stdout: "pipe",
    stderr: "pipe",
  })

  if (result.exitCode !== 0) {
    return []
  }

  return result.stdout
    .toString()
    .trim()
    .split("\n")
    .filter((name) => name.length > 0)
}

function stopAndRemoveContainers(containers: string[], isRoot: boolean): { stopped: number; failed: string[] } {
  let stopped = 0
  const failed: string[] = []

  for (const container of containers) {
    // Stop container
    const stopResult = spawnSync({
      cmd: isRoot
        ? ["docker", "stop", container]
        : ["sudo", "docker", "stop", container],
      stdout: "pipe",
      stderr: "pipe",
    })

    // Remove container (even if stop failed - might already be stopped)
    const rmResult = spawnSync({
      cmd: isRoot
        ? ["docker", "rm", "-f", container]
        : ["sudo", "docker", "rm", "-f", container],
      stdout: "pipe",
      stderr: "pipe",
    })

    if (rmResult.exitCode === 0) {
      stopped++
    } else {
      failed.push(container)
    }
  }

  return { stopped, failed }
}

async function uninstallRemote(target: string, options: UninstallOptions): Promise<void> {
  p.intro(chalk.bgCyan(" siteio agent uninstall (remote) "))

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

  // Check if siteio is installed
  s.start("Checking if siteio is installed on remote")
  const checkResult = await sshExec(target, "which siteio || echo 'not-found'", options.identity)
  if (checkResult.stdout.includes("not-found")) {
    s.stop(chalk.yellow("siteio not found"))
    console.log(chalk.yellow("siteio is not installed on the remote server."))
    process.exit(0)
  }
  s.stop(chalk.green("siteio found"))

  // Build the remote uninstall command with flags
  let remoteCmd = "siteio agent uninstall"
  if (options.removeContainers) {
    remoteCmd += " --remove-containers"
  }
  if (options.removeData) {
    remoteCmd += " --remove-data"
  }
  if (options.yes) {
    remoteCmd += " --yes"
  }

  // Run remote uninstall
  console.log(chalk.cyan("\nRunning agent uninstall on remote server..."))
  const uninstallCode = await sshExecStream(target, remoteCmd, options.identity)

  if (uninstallCode !== 0) {
    console.error(formatError("Remote agent uninstall failed"))
    process.exit(1)
  }

  console.log("")
  p.outro(chalk.green("Remote uninstall complete!"))
}

async function uninstallLocal(options: UninstallOptions): Promise<void> {
  p.intro(chalk.bgCyan(" siteio agent uninstall "))

  // Check if running as root or with sudo capability
  const whoami = spawnSync({ cmd: ["whoami"], stdout: "pipe" })
  const isRoot = whoami.stdout.toString().trim() === "root"

  if (!isRoot) {
    const sudoCheck = spawnSync({ cmd: ["sudo", "-n", "true"], stdout: "pipe", stderr: "pipe" })
    if (sudoCheck.exitCode !== 0) {
      console.log(chalk.yellow("This command requires sudo privileges."))
    }
  }

  // Check if service exists
  if (!existsSync(SERVICE_FILE)) {
    console.log(chalk.yellow("siteio agent service is not installed."))
    p.outro(chalk.gray("Nothing to uninstall."))
    return
  }

  // Confirm uninstall
  if (!options.yes) {
    const confirm = await p.confirm({
      message: "Are you sure you want to uninstall the siteio agent?",
      initialValue: false,
    })

    if (p.isCancel(confirm) || !confirm) {
      p.cancel("Uninstall cancelled")
      process.exit(0)
    }
  }

  const s = p.spinner()

  // Check for Cloudflare DNS cleanup
  const agentConfig = loadAgentConfig(DEFAULT_DATA_DIR)
  if (agentConfig.cloudflareToken && agentConfig.domain) {
    s.start("Removing Cloudflare DNS record")
    try {
      const result = await removeWildcardDNS(agentConfig.cloudflareToken, agentConfig.domain)
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
      console.log(formatWarning(`Could not remove DNS record: ${message}`))
    }
  }

  // Check for Docker containers
  const containers = listSiteioContainers()
  if (containers.length > 0) {
    console.log("")
    console.log(chalk.yellow(`Found ${containers.length} siteio container(s):`))
    for (const container of containers) {
      console.log(chalk.gray(`  - ${container}`))
    }
    console.log("")

    let shouldRemoveContainers = options.removeContainers

    if (!shouldRemoveContainers && !options.yes) {
      const removeContainers = await p.confirm({
        message: "Stop and remove these Docker containers?",
        initialValue: true,
      })

      if (!p.isCancel(removeContainers)) {
        shouldRemoveContainers = removeContainers
      }
    }

    if (shouldRemoveContainers) {
      s.start("Stopping and removing Docker containers")
      const { stopped, failed } = stopAndRemoveContainers(containers, isRoot)

      if (failed.length > 0) {
        s.stop(chalk.yellow(`Removed ${stopped} container(s), ${failed.length} failed`))
        for (const name of failed) {
          console.log(chalk.red(`  Failed to remove: ${name}`))
        }
      } else {
        s.stop(chalk.green(`Removed ${stopped} container(s)`))
      }
    } else {
      console.log(chalk.gray("Docker containers preserved"))
    }
  }

  // Stop the service
  s.start("Stopping service")
  const stopResult = spawnSync({
    cmd: isRoot
      ? ["systemctl", "stop", SERVICE_NAME]
      : ["sudo", "systemctl", "stop", SERVICE_NAME],
    stdout: "pipe",
    stderr: "pipe",
  })
  // Ignore errors - service might already be stopped
  s.stop(stopResult.exitCode === 0 ? chalk.green("Service stopped") : chalk.yellow("Service was not running"))

  // Disable the service
  s.start("Disabling service")
  const disableResult = spawnSync({
    cmd: isRoot
      ? ["systemctl", "disable", SERVICE_NAME]
      : ["sudo", "systemctl", "disable", SERVICE_NAME],
    stdout: "pipe",
    stderr: "pipe",
  })
  s.stop(disableResult.exitCode === 0 ? chalk.green("Service disabled") : chalk.yellow("Service was not enabled"))

  // Remove service file
  s.start("Removing service file")
  const rmResult = spawnSync({
    cmd: isRoot
      ? ["rm", "-f", SERVICE_FILE]
      : ["sudo", "rm", "-f", SERVICE_FILE],
    stdout: "pipe",
    stderr: "pipe",
  })

  if (rmResult.exitCode !== 0) {
    s.stop(chalk.red("Failed"))
    console.error(formatError(`Could not remove service file: ${rmResult.stderr.toString()}`))
    process.exit(1)
  }
  s.stop(chalk.green("Service file removed"))

  // Reload systemd
  s.start("Reloading systemd")
  spawnSync({
    cmd: isRoot
      ? ["systemctl", "daemon-reload"]
      : ["sudo", "systemctl", "daemon-reload"],
    stdout: "pipe",
    stderr: "pipe",
  })
  s.stop(chalk.green("Systemd reloaded"))

  // Optionally remove data directory
  if (options.removeData) {
    s.start(`Removing data directory (${DEFAULT_DATA_DIR})`)
    const rmDataResult = spawnSync({
      cmd: isRoot
        ? ["rm", "-rf", DEFAULT_DATA_DIR]
        : ["sudo", "rm", "-rf", DEFAULT_DATA_DIR],
      stdout: "pipe",
      stderr: "pipe",
    })

    if (rmDataResult.exitCode !== 0) {
      s.stop(chalk.red("Failed"))
      console.error(formatError(`Could not remove data directory: ${rmDataResult.stderr.toString()}`))
    } else {
      s.stop(chalk.green("Data directory removed"))
    }
  } else if (!options.yes) {
    // Ask about data directory
    const removeData = await p.confirm({
      message: `Remove data directory (${DEFAULT_DATA_DIR})? This will delete all sites and apps.`,
      initialValue: false,
    })

    if (removeData && !p.isCancel(removeData)) {
      s.start(`Removing data directory (${DEFAULT_DATA_DIR})`)
      const rmDataResult = spawnSync({
        cmd: isRoot
          ? ["rm", "-rf", DEFAULT_DATA_DIR]
          : ["sudo", "rm", "-rf", DEFAULT_DATA_DIR],
        stdout: "pipe",
        stderr: "pipe",
      })

      if (rmDataResult.exitCode !== 0) {
        s.stop(chalk.red("Failed"))
        console.error(formatError(`Could not remove data directory: ${rmDataResult.stderr.toString()}`))
      } else {
        s.stop(chalk.green("Data directory removed"))
      }
    } else {
      console.log(chalk.gray(`Data directory preserved at ${DEFAULT_DATA_DIR}`))
    }
  }

  console.log("")
  console.log(formatSuccess("siteio agent uninstalled!"))
  console.log("")

  p.outro(chalk.green("Uninstall complete!"))
}

export async function uninstallAgentCommand(target?: string, options: UninstallOptions = {}): Promise<void> {
  if (target && isRemoteTarget(target)) {
    await uninstallRemote(target, options)
  } else {
    await uninstallLocal(options)
  }
}
