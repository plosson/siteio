import { existsSync, readFileSync } from "fs"
import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { formatSuccess } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import { resolveAppName } from "../../utils/site-config.ts"
import type { VolumeMount, RestartPolicy } from "../../types.ts"

export interface SetAppOptions {
  env?: string[]
  volume?: string[]
  domain?: string[]
  port?: number
  restart?: string
  image?: string
  dockerfile?: string
  gitToken?: string
  json?: boolean
}

function parseEnvFile(filePath: string): Record<string, string> {
  const content = readFileSync(filePath, "utf-8")
  const env: Record<string, string> = {}
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const idx = trimmed.indexOf("=")
    if (idx === -1) continue
    const key = trimmed.slice(0, idx).trim()
    let value = trimmed.slice(idx + 1).trim()
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key) env[key] = value
  }
  return env
}

function parseEnvVars(envArgs: string[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const e of envArgs) {
    const idx = e.indexOf("=")
    if (idx === -1) {
      // No '=' found — check if it's a file path
      if (existsSync(e)) {
        Object.assign(env, parseEnvFile(e))
      } else {
        throw new ValidationError(`Invalid env format: ${e}. Use KEY=value or provide a path to an env file`)
      }
    } else {
      const key = e.slice(0, idx)
      const value = e.slice(idx + 1)
      env[key] = value
    }
  }
  return env
}

function parseVolumes(volumeArgs: string[]): VolumeMount[] {
  const volumes: VolumeMount[] = []
  for (const v of volumeArgs) {
    const parts = v.split(":")
    if (parts.length !== 2) {
      throw new ValidationError(`Invalid volume format: ${v}. Use name:path`)
    }
    volumes.push({ name: parts[0]!, mountPath: parts[1]! })
  }
  return volumes
}

function validateRestartPolicy(policy: string): RestartPolicy {
  const valid = ["always", "unless-stopped", "on-failure", "no"]
  if (!valid.includes(policy)) {
    throw new ValidationError(
      `Invalid restart policy: ${policy}. Valid values: ${valid.join(", ")}`
    )
  }
  return policy as RestartPolicy
}

export async function setAppCommand(
  name: string | undefined,
  options: SetAppOptions = {}
): Promise<void> {
  const spinner = ora()

  try {
    const server = getCurrentServer()
    const resolved = resolveAppName(name, server?.domain ?? "")
    if (!resolved) {
      throw new ValidationError("App name required. Provide as argument or run from a directory with .siteio/config.json")
    }
    if (!name) {
      console.error(chalk.dim(`Using app '${resolved}' from .siteio/config.json`))
    }
    name = resolved

    const client = new SiteioClient()

    // Build updates object
    const updates: {
      env?: Record<string, string>
      volumes?: VolumeMount[]
      domains?: string[]
      internalPort?: number
      restartPolicy?: RestartPolicy
      image?: string
      // Partial patch — server merges with existing app.git
      git?: { repoUrl?: string; branch?: string; dockerfile?: string; context?: string; token?: string }
    } = {}

    if (options.env && options.env.length > 0) {
      updates.env = parseEnvVars(options.env)
    }

    if (options.volume && options.volume.length > 0) {
      updates.volumes = parseVolumes(options.volume)
    }

    if (options.domain && options.domain.length > 0) {
      updates.domains = options.domain
    }

    if (options.port !== undefined) {
      updates.internalPort = options.port
    }

    if (options.restart) {
      updates.restartPolicy = validateRestartPolicy(options.restart)
    }

    if (options.image) {
      updates.image = options.image
    }

    if (options.dockerfile || options.gitToken !== undefined) {
      // Validate the app is git-based. Server does the field-level merge.
      const current = await client.getApp(name)
      if (!current.git) {
        throw new ValidationError("Cannot set --dockerfile or --git-token on a non-git app")
      }
      const gitPatch: { dockerfile?: string; token?: string } = {}
      if (options.dockerfile) {
        gitPatch.dockerfile = options.dockerfile
      }
      if (options.gitToken !== undefined) {
        // Empty string clears the stored token
        gitPatch.token = options.gitToken === "" ? undefined : options.gitToken
      }
      updates.git = gitPatch
    }

    if (Object.keys(updates).length === 0) {
      throw new ValidationError(
        "No updates specified. Use --env, --volume, --domain, --port, --restart, --image, or --dockerfile"
      )
    }

    spinner.start(`Updating app ${name}`)

    const app = await client.updateApp(name, updates)

    spinner.succeed(`Updated app ${name}`)

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: app }, null, 2))
    } else {
      console.log("")
      console.log(formatSuccess(`App ${chalk.bold(name)} updated.`))
      console.log("")

      // Show what was updated
      if (updates.env) {
        console.log(chalk.bold("Environment variables set:"))
        for (const [key, value] of Object.entries(updates.env)) {
          console.log(`  ${key}=${chalk.dim(value)}`)
        }
      }

      if (updates.volumes) {
        console.log(chalk.bold("Volumes set:"))
        for (const vol of updates.volumes) {
          console.log(`  ${vol.name}:${vol.mountPath}`)
        }
      }

      if (updates.domains) {
        console.log(chalk.bold("Domains set:"))
        for (const d of updates.domains) {
          console.log(`  ${chalk.cyan(d)}`)
        }
      }

      if (updates.internalPort !== undefined) {
        console.log(`Port: ${updates.internalPort}`)
      }

      if (updates.restartPolicy) {
        console.log(`Restart policy: ${updates.restartPolicy}`)
      }

      if (updates.image) {
        console.log(`Image: ${updates.image}`)
      }

      if (updates.git) {
        if (options.dockerfile) {
          console.log(`Dockerfile: ${updates.git.dockerfile}`)
        }
        if (options.gitToken !== undefined) {
          console.log(`Git token: ${updates.git.token ? chalk.dim("***") : chalk.dim("(cleared)")}`)
        }
      }

      console.log("")

      if (app.status === "running") {
        console.log(chalk.dim(`Restart the app for changes to take effect: siteio apps restart ${name}`))
        console.log("")
      }
    }
    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
