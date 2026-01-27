import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { formatSuccess } from "../../utils/output.ts"
import { handleError } from "../../utils/errors.ts"
import type { AuthOptions, SiteOAuth } from "../../types.ts"

export async function authCommand(subdomain: string, options: AuthOptions): Promise<void> {
  const spinner = ora()

  try {
    const client = new SiteioClient()

    if (options.remove) {
      // Remove auth
      spinner.start(`Removing authentication from ${subdomain}`)
      await client.updateSiteOAuth(subdomain, null)
      spinner.succeed("Authentication removed")

      console.error("")
      console.error(formatSuccess(`Site ${subdomain} is now public`))
      console.error("")

      console.log(JSON.stringify({ success: true, data: { subdomain, oauth: null } }, null, 2))
    } else {
      // Check if OAuth is configured on the server
      spinner.start("Checking OAuth status")
      const oauthEnabled = await client.getOAuthStatus()
      spinner.stop()

      if (!oauthEnabled) {
        console.error(chalk.red("Google authentication not configured on the server."))
        console.error("")
        console.error(chalk.yellow("Run 'siteio agent oauth' on the server to enable Google authentication."))
        console.error("")
        process.exit(1)
      }

      // Validate options
      if (!options.allowedEmails && !options.allowedDomain) {
        console.error(chalk.red("Please specify --allowed-emails or --allowed-domain"))
        console.error("")
        console.error("Examples:")
        console.error(`  siteio sites auth ${subdomain} --allowed-emails "user@gmail.com,other@company.com"`)
        console.error(`  siteio sites auth ${subdomain} --allowed-domain company.com`)
        console.error("")
        process.exit(1)
      }

      // Build OAuth config
      const oauth: SiteOAuth = {}

      if (options.allowedEmails) {
        oauth.allowedEmails = options.allowedEmails.split(",").map((e) => e.trim().toLowerCase())
      }

      if (options.allowedDomain) {
        oauth.allowedDomain = options.allowedDomain.toLowerCase()
      }

      spinner.start(`Setting authentication for ${subdomain}`)
      await client.updateSiteOAuth(subdomain, oauth)
      spinner.succeed("Authentication configured")

      console.error("")
      console.error(formatSuccess(`Site ${subdomain} now requires Google authentication`))
      if (oauth.allowedEmails) {
        console.error(`  Allowed emails: ${chalk.cyan(oauth.allowedEmails.join(", "))}`)
      }
      if (oauth.allowedDomain) {
        console.error(`  Allowed domain: ${chalk.cyan(oauth.allowedDomain)}`)
      }
      console.error("")

      console.log(JSON.stringify({ success: true, data: { subdomain, oauth } }, null, 2))
    }

    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
