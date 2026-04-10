import { readFileSync } from "fs"
import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { getCurrentServer } from "../../config/loader.ts"
import { formatSuccess } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import { saveProjectConfig } from "../../utils/site-config.ts"

export interface CreateAppOptions {
  image?: string
  git?: string
  file?: string
  dockerfile?: string
  branch?: string
  context?: string
  port?: number
  json?: boolean
}

export async function createAppCommand(
  name: string,
  options: CreateAppOptions
): Promise<void> {
  const spinner = ora()

  try {
    if (!name) {
      throw new ValidationError("App name is required")
    }

    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(name)) {
      throw new ValidationError(
        "App name must contain only lowercase letters, numbers, and hyphens, and cannot start or end with a hyphen"
      )
    }

    // Must provide exactly one of --image, --git, or --file
    const sources = [options.image, options.git, options.file].filter(Boolean)
    if (sources.length > 1) {
      throw new ValidationError("Specify only one of --image, --git, or --file")
    }
    if (sources.length === 0) {
      throw new ValidationError("One of --image, --git, or --file is required")
    }

    const isGitBased = !!options.git
    const isDockerfileBased = !!options.file

    // Read the local Dockerfile up-front so we fail fast on bad paths
    let dockerfileContent: string | undefined
    if (options.file) {
      try {
        dockerfileContent = readFileSync(options.file, "utf-8")
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new ValidationError(`Failed to read Dockerfile at '${options.file}': ${message}`)
      }
    }

    spinner.start(`Creating app ${name}`)

    const client = new SiteioClient()
    const app = await client.createApp({
      name,
      image: options.image,
      git: options.git
        ? {
            repoUrl: options.git,
            branch: options.branch,
            dockerfile: options.dockerfile,
            context: options.context,
          }
        : undefined,
      dockerfileContent,
      internalPort: options.port,
    })

    spinner.succeed(`Created app ${name}`)

    // Save config for source-based apps (folder context is meaningful)
    if (isGitBased || isDockerfileBased) {
      const server = getCurrentServer()
      if (server) {
        saveProjectConfig({ app: name, domain: server.domain })
      }
    }

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: app }, null, 2))
    } else {
      console.log("")
      console.log(formatSuccess(`App ${chalk.bold(name)} created successfully!`))
      console.log("")
      console.log(`  Name:   ${chalk.cyan(app.name)}`)
      if (isGitBased) {
        console.log(`  Source: ${chalk.blue("git")}`)
        console.log(`  Repo:   ${options.git}`)
        if (options.branch) console.log(`  Branch: ${options.branch}`)
        if (options.dockerfile) console.log(`  Dockerfile: ${options.dockerfile}`)
        if (options.context) console.log(`  Context: ${options.context}`)
      } else if (isDockerfileBased) {
        console.log(`  Source: ${chalk.blue("dockerfile")}`)
        console.log(`  File:   ${options.file}`)
      } else {
        console.log(`  Image:  ${app.image}`)
      }
      console.log(`  Port:   ${app.internalPort}`)
      console.log(`  Status: ${chalk.yellow(app.status)}`)
      console.log("")
      console.log(chalk.dim(`Run 'siteio apps deploy ${name}' to start the container`))
      console.log("")
    }
    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
