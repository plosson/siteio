import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { formatSuccess, generatePassword } from "../../utils/output.ts"
import { handleError } from "../../utils/errors.ts"
import type { AuthOptions } from "../../types.ts"

export async function authCommand(subdomain: string, options: AuthOptions): Promise<void> {
  const spinner = ora()

  try {
    const client = new SiteioClient()

    if (options.remove) {
      // Remove auth
      spinner.start(`Removing authentication from ${subdomain}`)
      await client.updateSiteAuth(subdomain, null)
      spinner.succeed("Authentication removed")

      console.error("")
      console.error(formatSuccess(`Site ${subdomain} is now public`))
      console.error("")

      console.log(JSON.stringify({ success: true, data: { subdomain, auth: false } }, null, 2))
    } else {
      // Set auth - use defaults if not provided
      const user = options.user || subdomain
      const password = options.password || generatePassword(13)
      const generatedPassword = !options.password ? password : undefined

      spinner.start(`Setting authentication for ${subdomain}`)
      await client.updateSiteAuth(subdomain, { user, password })
      spinner.succeed("Authentication configured")

      console.error("")
      console.error(formatSuccess(`Site ${subdomain} now requires authentication`))
      console.error(`  User: ${chalk.cyan(user)}`)
      if (generatedPassword) {
        console.error(`  Password: ${chalk.cyan(generatedPassword)} ${chalk.dim("(generated)")}`)
      }
      console.error("")

      const output: Record<string, unknown> = {
        success: true,
        data: { subdomain, auth: true, user, password: generatedPassword || "(provided)" }
      }
      console.log(JSON.stringify(output, null, 2))
    }

    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
