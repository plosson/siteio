import chalk from "chalk"
import { SiteioClient } from "../lib/client.ts"
import { formatDim, formatSuccess, formatTable } from "../utils/output.ts"
import { handleError } from "../utils/errors.ts"

interface Out {
  json?: boolean
}

function printJson(data: unknown): void {
  console.log(JSON.stringify({ success: true, data }, null, 2))
}

function printPassword(username: string, password: string): void {
  console.error(`  Username: ${username}`)
  console.error(`  Password: ${chalk.bold(password)}`)
  console.error(chalk.yellow("  ! Shown only once. They can change it in the admin UI."))
}

export async function usersListCommand(options: Out): Promise<void> {
  try {
    const users = await new SiteioClient().listUsers()
    if (options.json) printJson(users)
    else if (users.length === 0) console.error(formatDim("No users."))
    else {
      console.error(formatTable(
        ["USERNAME", "ROLE", "SCOPE", "CREATED"],
        users.map((u) => [u.username, u.role, u.tenant ?? "main domain", u.createdAt.slice(0, 10)])
      ))
    }
    process.exit(0)
  } catch (err) {
    handleError(err)
  }
}

export async function usersAddCommand(username: string, options: Out & { role?: string; tenant?: string }): Promise<void> {
  try {
    const created = await new SiteioClient().createUser({ username, role: options.role, tenant: options.tenant })
    if (options.json) printJson(created)
    else {
      const scope = created.user.tenant ?? "the main domain"
      console.error(formatSuccess(`User '${created.user.username}' added (${created.user.role}, ${scope})`))
      printPassword(created.user.username, created.password)
    }
    process.exit(0)
  } catch (err) {
    handleError(err)
  }
}

export async function usersRemoveCommand(username: string, options: Out): Promise<void> {
  try {
    await new SiteioClient().deleteUser(username)
    if (options.json) printJson({ deleted: username })
    else console.error(formatSuccess(`User '${username}' removed`))
    process.exit(0)
  } catch (err) {
    handleError(err)
  }
}

export async function usersResetPasswordCommand(username: string, options: Out): Promise<void> {
  try {
    const reset = await new SiteioClient().resetUserPassword(username)
    if (options.json) printJson(reset)
    else {
      console.error(formatSuccess(`New password for '${reset.username}'`))
      printPassword(reset.username, reset.password)
    }
    process.exit(0)
  } catch (err) {
    handleError(err)
  }
}

export async function usersKeysCommand(options: Out): Promise<void> {
  try {
    const keys = await new SiteioClient().listMyKeys()
    if (options.json) printJson(keys)
    else if (keys.length === 0) console.error(formatDim("No keys (the god key and tenant keys have none)."))
    else {
      console.error(formatTable(
        ["ID", "KIND", "NAME", "CREATED"],
        keys.map((k) => [k.id, k.kind, k.name, k.createdAt.slice(0, 10)])
      ))
    }
    process.exit(0)
  } catch (err) {
    handleError(err)
  }
}

export async function usersRevokeKeyCommand(id: string, options: Out): Promise<void> {
  try {
    await new SiteioClient().revokeMyKey(id)
    if (options.json) printJson({ revoked: id })
    else console.error(formatSuccess(`Key '${id}' revoked`))
    process.exit(0)
  } catch (err) {
    handleError(err)
  }
}
