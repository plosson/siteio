import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { formatSuccess } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import type { VolumeMount, RestartPolicy } from "../../types.ts"

export interface SetAppOptions {
  env?: string[]
  volume?: string[]
  domain?: string[]
  port?: number
  restart?: string
  image?: string
  json?: boolean
}

function parseEnvVars(envArgs: string[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const e of envArgs) {
    const idx = e.indexOf("=")
    if (idx === -1) {
      throw new ValidationError(`Invalid env format: ${e}. Use KEY=value`)
    }
    const key = e.slice(0, idx)
    const value = e.slice(idx + 1)
    env[key] = value
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
  name: string,
  options: SetAppOptions = {}
): Promise<void> {
  const spinner = ora()

  try {
    if (!name) {
      throw new ValidationError("App name is required")
    }

    // Build updates object
    const updates: {
      env?: Record<string, string>
      volumes?: VolumeMount[]
      domains?: string[]
      internalPort?: number
      restartPolicy?: RestartPolicy
      image?: string
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

    if (Object.keys(updates).length === 0) {
      throw new ValidationError(
        "No updates specified. Use --env, --volume, --domain, --port, --restart, or --image"
      )
    }

    spinner.start(`Updating app ${name}`)

    const client = new SiteioClient()
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
