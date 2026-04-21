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
  composeFile?: string
  compose?: string
  service?: string
  envFile?: string
  branch?: string
  context?: string
  gitToken?: string
  port?: number
  json?: boolean
}

/**
 * Pure validation of the source-flag combinations. Throws ValidationError
 * on any invalid combination. Kept separate from createAppCommand so it can
 * be exercised directly in unit tests without going through handleError.
 */
export function validateCreateOptions(options: CreateAppOptions): void {
  const hasCompose = !!options.composeFile || !!options.compose
  const hasLocalDockerfile = !!options.file
  const hasImage = !!options.image
  const hasGit = !!options.git

  const primarySources = [hasImage, hasLocalDockerfile, hasCompose, hasGit].filter(Boolean).length
  if (primarySources === 0) {
    throw new ValidationError("One of --image, --git, --file, or --compose-file is required")
  }
  if (hasImage && (hasLocalDockerfile || hasCompose || hasGit)) {
    throw new ValidationError("--image cannot be combined with other source flags")
  }
  if (hasLocalDockerfile && (hasCompose || hasGit)) {
    throw new ValidationError("--file cannot be combined with --git or --compose-file")
  }
  if (options.composeFile && options.compose) {
    throw new ValidationError("Specify either --compose-file (local) or --compose (git), not both")
  }
  if (options.compose && !options.git) {
    throw new ValidationError("--compose requires --git")
  }
  if (hasCompose && !options.service) {
    throw new ValidationError("--service is required when using a compose file")
  }
  if (!hasCompose && options.service) {
    throw new ValidationError("--service is only valid with --compose-file or --compose")
  }
  if (hasGit && options.dockerfile && options.compose) {
    throw new ValidationError("Cannot combine --dockerfile and --compose in the same git app")
  }
  if (options.envFile && !hasCompose) {
    throw new ValidationError("--env-file is only valid with --compose-file or --compose")
  }
  if (options.gitToken && !hasGit) {
    throw new ValidationError("--git-token requires --git")
  }
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

    validateCreateOptions(options)

    const hasCompose = !!options.composeFile || !!options.compose
    const hasLocalDockerfile = !!options.file
    const hasGit = !!options.git

    let dockerfileContent: string | undefined
    if (options.file) {
      try {
        dockerfileContent = readFileSync(options.file, "utf-8")
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new ValidationError(`Failed to read Dockerfile at '${options.file}': ${message}`)
      }
    }
    let composeContent: string | undefined
    if (options.composeFile) {
      try {
        composeContent = readFileSync(options.composeFile, "utf-8")
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new ValidationError(`Failed to read compose file at '${options.composeFile}': ${message}`)
      }
    }
    let envFileContent: string | undefined
    if (options.envFile) {
      try {
        envFileContent = readFileSync(options.envFile, "utf-8")
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new ValidationError(`Failed to read env file at '${options.envFile}': ${message}`)
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
            token: options.gitToken,
          }
        : undefined,
      dockerfileContent,
      composeContent,
      envFileContent,
      composePath: options.compose,
      primaryService: options.service,
      internalPort: options.port,
    })

    spinner.succeed(`Created app ${name}`)

    if (hasGit || hasLocalDockerfile || options.composeFile) {
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
      if (hasCompose) {
        console.log(`  Source: ${chalk.blue("compose")}`)
        if (options.composeFile) {
          console.log(`  File:    ${options.composeFile}`)
        } else {
          console.log(`  Repo:    ${options.git}`)
          console.log(`  Compose: ${options.compose}`)
        }
        console.log(`  Service: ${options.service}`)
      } else if (hasGit) {
        console.log(`  Source: ${chalk.blue("git")}`)
        console.log(`  Repo:   ${options.git}`)
        if (options.branch) console.log(`  Branch: ${options.branch}`)
        if (options.dockerfile) console.log(`  Dockerfile: ${options.dockerfile}`)
        if (options.context) console.log(`  Context: ${options.context}`)
      } else if (hasLocalDockerfile) {
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
