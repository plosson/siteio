import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../../lib/client.ts"
import { formatSuccess } from "../../utils/output.ts"
import { handleError } from "../../utils/errors.ts"
import type { AuthOptions, SiteOAuth } from "../../types.ts"

export async function authCommand(subdomain: string, options: AuthOptions & { json?: boolean }): Promise<void> {
  const spinner = ora()

  try {
    const client = new SiteioClient()

    if (options.remove) {
      // Remove auth
      spinner.start(`Removing authentication from ${subdomain}`)
      await client.updateSiteOAuth(subdomain, null)
      spinner.succeed("Authentication removed")

      if (options.json) {
        console.log(JSON.stringify({ success: true, data: { subdomain, oauth: null } }, null, 2))
      } else {
        console.log("")
        console.log(formatSuccess(`Site ${subdomain} is now public`))
        console.log("")
      }
      process.exit(0)
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

      // Check if we're doing incremental operations
      const isIncremental =
        options.addEmail ||
        options.removeEmail ||
        options.addDomain ||
        options.removeDomain ||
        options.addGroup ||
        options.removeGroup

      let oauth: SiteOAuth

      if (isIncremental) {
        // Fetch current site OAuth config
        spinner.start(`Fetching current config for ${subdomain}`)
        const site = await client.getSite(subdomain)
        spinner.stop()

        if (!site) {
          console.error(chalk.red(`Site '${subdomain}' not found`))
          process.exit(1)
        }

        // Start with existing config or empty
        oauth = site.oauth || {}

        // Apply incremental changes
        if (options.addEmail) {
          const newEmails = options.addEmail.split(",").map((e) => e.trim().toLowerCase())
          oauth.allowedEmails = oauth.allowedEmails || []
          for (const email of newEmails) {
            if (!oauth.allowedEmails.includes(email)) {
              oauth.allowedEmails.push(email)
            }
          }
        }

        if (options.removeEmail) {
          const removeEmails = options.removeEmail.split(",").map((e) => e.trim().toLowerCase())
          if (oauth.allowedEmails) {
            oauth.allowedEmails = oauth.allowedEmails.filter((e) => !removeEmails.includes(e))
            if (oauth.allowedEmails.length === 0) {
              delete oauth.allowedEmails
            }
          }
        }

        if (options.addDomain) {
          oauth.allowedDomain = options.addDomain.toLowerCase()
        }

        if (options.removeDomain) {
          if (oauth.allowedDomain === options.removeDomain.toLowerCase()) {
            delete oauth.allowedDomain
          }
        }

        if (options.addGroup) {
          const newGroups = options.addGroup.split(",").map((g) => g.trim().toLowerCase())
          oauth.allowedGroups = oauth.allowedGroups || []
          for (const group of newGroups) {
            if (!oauth.allowedGroups.includes(group)) {
              oauth.allowedGroups.push(group)
            }
          }
        }

        if (options.removeGroup) {
          const removeGroups = options.removeGroup.split(",").map((g) => g.trim().toLowerCase())
          if (oauth.allowedGroups) {
            oauth.allowedGroups = oauth.allowedGroups.filter((g) => !removeGroups.includes(g))
            if (oauth.allowedGroups.length === 0) {
              delete oauth.allowedGroups
            }
          }
        }

        // Check if any auth settings remain
        if (!oauth.allowedEmails && !oauth.allowedDomain && !oauth.allowedGroups) {
          // No auth settings left, remove auth entirely
          spinner.start(`Removing authentication from ${subdomain}`)
          await client.updateSiteOAuth(subdomain, null)
          spinner.succeed("Authentication removed (no allowed emails/domains/groups left)")

          if (options.json) {
            console.log(JSON.stringify({ success: true, data: { subdomain, oauth: null } }, null, 2))
          } else {
            console.log("")
            console.log(formatSuccess(`Site ${subdomain} is now public`))
            console.log("")
          }
          process.exit(0)
        }
      } else {
        // Full replacement mode
        if (!options.allowedEmails && !options.allowedDomain && !options.allowedGroups) {
          console.error(chalk.red("Please specify at least one of:"))
          console.error("  --allowed-emails, --allowed-domain, --allowed-groups (set)")
          console.error("  --add-email, --remove-email (incremental)")
          console.error("  --add-domain, --remove-domain (incremental)")
          console.error("  --add-group, --remove-group (incremental)")
          console.error("")
          console.error("Examples:")
          console.error(`  siteio sites auth ${subdomain} --allowed-emails "user@gmail.com"`)
          console.error(`  siteio sites auth ${subdomain} --add-email "new@gmail.com"`)
          console.error(`  siteio sites auth ${subdomain} --allowed-groups "engineering"`)
          console.error("")
          process.exit(1)
        }

        // Build OAuth config from scratch
        oauth = {}

        if (options.allowedEmails) {
          oauth.allowedEmails = options.allowedEmails.split(",").map((e) => e.trim().toLowerCase())
        }

        if (options.allowedDomain) {
          oauth.allowedDomain = options.allowedDomain.toLowerCase()
        }

        if (options.allowedGroups) {
          oauth.allowedGroups = options.allowedGroups.split(",").map((g) => g.trim().toLowerCase())
        }
      }

      spinner.start(`Setting authentication for ${subdomain}`)
      await client.updateSiteOAuth(subdomain, oauth)
      spinner.succeed("Authentication configured")

      if (options.json) {
        console.log(JSON.stringify({ success: true, data: { subdomain, oauth } }, null, 2))
      } else {
        console.log("")
        console.log(formatSuccess(`Site ${subdomain} now requires Google authentication`))
        if (oauth.allowedEmails && oauth.allowedEmails.length > 0) {
          console.log(`  Allowed emails: ${chalk.cyan(oauth.allowedEmails.join(", "))}`)
        }
        if (oauth.allowedDomain) {
          console.log(`  Allowed domain: ${chalk.cyan(oauth.allowedDomain)}`)
        }
        if (oauth.allowedGroups && oauth.allowedGroups.length > 0) {
          console.log(`  Allowed groups: ${chalk.cyan(oauth.allowedGroups.join(", "))}`)
        }
        console.log("")
      }
    }

    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
