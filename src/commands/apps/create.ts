import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { formatSuccess } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

export interface CreateAppOptions {
  image?: string
  git?: string
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

    // Must provide either --image or --git, but not both
    if (options.image && options.git) {
      throw new ValidationError("Cannot specify both --image and --git")
    }

    if (!options.image && !options.git) {
      throw new ValidationError("Either --image or --git is required")
    }

    const isGitBased = !!options.git

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
      internalPort: options.port,
    })

    spinner.succeed(`Created app ${name}`)

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
