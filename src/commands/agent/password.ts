import chalk from "chalk"
import { getAgentDataDir, loadAgentConfig } from "../../config/agent.ts"
import { UserStore, generatePassword } from "../../lib/agent/user-store.ts"
import { formatError, formatSuccess } from "../../utils/output.ts"

// On-box: set or reset the admin's password (creates the admin on first run).
// The running agent sees it at once: it reads users from disk on every login.
export async function agentPasswordCommand(options: { json?: boolean; password?: string }): Promise<void> {
  const dataDir = getAgentDataDir()
  const password = options.password ?? generatePassword()
  try {
    await new UserStore(dataDir).setAdminPassword(password)
  } catch (err) {
    console.error(formatError(err instanceof Error ? err.message : String(err)))
    process.exit(1)
  }
  if (options.json) {
    console.log(JSON.stringify({ username: "admin", password }))
    return
  }
  const domain = loadAgentConfig(dataDir).domain
  console.error(formatSuccess("Admin password set"))
  console.error(`  Username: admin`)
  console.error(`  Password: ${chalk.bold(password)}`)
  if (domain) console.error(chalk.gray(`  Log in at https://api.${domain}/ui`))
  if (!options.password) console.error(chalk.yellow("  ! Shown only once."))
}
