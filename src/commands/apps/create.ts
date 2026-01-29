import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { formatSuccess } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

export interface CreateAppOptions {
  image: string
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

    if (!options.image) {
      throw new ValidationError("Image is required (--image)")
    }

    spinner.start(`Creating app ${name}`)

    const client = new SiteioClient()
    const app = await client.createApp({
      name,
      image: options.image,
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
      console.log(`  Image:  ${app.image}`)
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
