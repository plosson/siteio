import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { formatSuccess } from "../../utils/output.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

export async function undeployCommand(subdomain: string, options: { json?: boolean } = {}): Promise<void> {
  const spinner = ora()

  try {
    if (!subdomain) {
      throw new ValidationError("Subdomain is required")
    }

    if (!/^[a-z0-9-]+$/.test(subdomain)) {
      throw new ValidationError("Invalid subdomain format")
    }

    spinner.start(`Undeploying ${subdomain}`)

    const client = new SiteioClient()
    await client.undeploySite(subdomain)

    spinner.succeed(`Undeployed ${subdomain}`)

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: { subdomain } }, null, 2))
    } else {
      console.log("")
      console.log(formatSuccess(`Site ${subdomain} has been removed.`))
    }
    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
