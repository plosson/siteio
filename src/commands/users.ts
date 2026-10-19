import chalk from "chalk"
import { SiteioClient } from "../lib/client.ts"
import { formatDim, formatSuccess, formatTable, printJson } from "../utils/output.ts"
import { handleError } from "../utils/errors.ts"

interface Out {
  json?: boolean
}

function printPassword(username: string, password: string): void {
  console.error(`  Username: ${username}`)
  console.error(`  Password: ${chalk.bold(password)}`)
  console.error(chalk.yellow("  ! Shown only once. They can change it in the admin UI."))
}

// Runs `call`, prints its result as JSON (`json` picks what, default all of it)
// or for a person, and exits.
async function run<T>(
  options: Out,
  call: () => Promise<T>,
  human: (result: T) => void,
  json: (result: T) => unknown = (r) => r
): Promise<void> {
  try {
    const result = await call()
    if (options.json) printJson(json(result))
    else human(result)
    process.exit(0)
  } catch (err) {
    handleError(err)
  }
}

export function usersListCommand(options: Out): Promise<void> {
  return run(options, () => new SiteioClient().listUsers(), (users) => {
    if (users.length === 0) console.error(formatDim("No users."))
    else {
      console.error(formatTable(
        ["USERNAME", "ROLE", "SCOPE", "CREATED"],
        users.map((u) => [u.username, u.role, u.tenant ?? "main domain", u.createdAt.slice(0, 10)])
      ))
    }
  })
}

export function usersAddCommand(username: string, options: Out & { role?: string; tenant?: string }): Promise<void> {
  return run(options, () => new SiteioClient().createUser({ username, role: options.role, tenant: options.tenant }), (created) => {
    const scope = created.user.tenant ?? "the main domain"
    console.error(formatSuccess(`User '${created.user.username}' added (${created.user.role}, ${scope})`))
    printPassword(created.user.username, created.password)
  })
}

export function usersRemoveCommand(username: string, options: Out): Promise<void> {
  return run(
    options,
    () => new SiteioClient().deleteUser(username),
    () => console.error(formatSuccess(`User '${username}' removed`)),
    () => ({ deleted: username })
  )
}

export function usersResetPasswordCommand(username: string, options: Out): Promise<void> {
  return run(options, () => new SiteioClient().resetUserPassword(username), (reset) => {
    console.error(formatSuccess(`New password for '${reset.username}'`))
    printPassword(reset.username, reset.password)
  })
}

export function usersKeysCommand(options: Out): Promise<void> {
  return run(options, () => new SiteioClient().listMyKeys(), (keys) => {
    if (keys.length === 0) console.error(formatDim("No keys (the god key and tenant keys have none)."))
    else {
      console.error(formatTable(
        ["ID", "KIND", "NAME", "CREATED"],
        keys.map((k) => [k.id, k.kind, k.name, k.createdAt.slice(0, 10)])
      ))
    }
  })
}

export function usersRevokeKeyCommand(id: string, options: Out): Promise<void> {
  return run(
    options,
    () => new SiteioClient().revokeMyKey(id),
    () => console.error(formatSuccess(`Key '${id}' revoked`)),
    () => ({ revoked: id })
  )
}
