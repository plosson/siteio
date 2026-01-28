import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../lib/client.ts"
import { formatSuccess } from "../utils/output.ts"
import { handleError } from "../utils/errors.ts"

export async function listGroupsCommand(): Promise<void> {
  const spinner = ora()

  try {
    const client = new SiteioClient()

    spinner.start("Fetching groups")
    const groups = await client.listGroups()
    spinner.stop()

    console.log(JSON.stringify({ success: true, data: groups }, null, 2))

    if (groups.length === 0) {
      console.error(chalk.gray("No groups defined"))
    } else {
      console.error("")
      console.error(chalk.bold("Groups:"))
      for (const group of groups) {
        console.error(`  ${chalk.cyan(group.name)} (${group.emails.length} emails)`)
      }
      console.error("")
    }

    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}

export async function showGroupCommand(name: string): Promise<void> {
  const spinner = ora()

  try {
    const client = new SiteioClient()

    spinner.start(`Fetching group ${name}`)
    const group = await client.getGroup(name)
    spinner.stop()

    if (!group) {
      console.error(chalk.red(`Group '${name}' not found`))
      process.exit(1)
    }

    console.log(JSON.stringify({ success: true, data: group }, null, 2))

    console.error("")
    console.error(chalk.bold(`Group: ${group.name}`))
    if (group.emails.length === 0) {
      console.error(chalk.gray("  No emails in this group"))
    } else {
      console.error("  Emails:")
      for (const email of group.emails) {
        console.error(`    - ${chalk.cyan(email)}`)
      }
    }
    console.error("")

    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}

export interface CreateGroupOptions {
  emails?: string
}

export async function createGroupCommand(name: string, options: CreateGroupOptions): Promise<void> {
  const spinner = ora()

  try {
    const client = new SiteioClient()

    const emails = options.emails ? options.emails.split(",").map((e) => e.trim()) : []

    spinner.start(`Creating group ${name}`)
    const group = await client.createGroup(name, emails)
    spinner.succeed("Group created")

    console.log(JSON.stringify({ success: true, data: group }, null, 2))

    console.error("")
    console.error(formatSuccess(`Group '${group.name}' created`))
    if (group.emails.length > 0) {
      console.error(`  Emails: ${chalk.cyan(group.emails.join(", "))}`)
    }
    console.error("")

    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}

export async function deleteGroupCommand(name: string): Promise<void> {
  const spinner = ora()

  try {
    const client = new SiteioClient()

    spinner.start(`Deleting group ${name}`)
    await client.deleteGroup(name)
    spinner.succeed("Group deleted")

    console.log(JSON.stringify({ success: true, data: null }, null, 2))

    console.error("")
    console.error(formatSuccess(`Group '${name}' deleted`))
    console.error("")

    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}

export interface ModifyGroupOptions {
  email?: string
}

export async function addToGroupCommand(name: string, options: ModifyGroupOptions): Promise<void> {
  const spinner = ora()

  try {
    if (!options.email) {
      console.error(chalk.red("Please specify --email to add"))
      process.exit(1)
    }

    const client = new SiteioClient()
    const emails = options.email.split(",").map((e) => e.trim())

    spinner.start(`Adding emails to group ${name}`)
    const group = await client.addEmailsToGroup(name, emails)
    spinner.succeed("Emails added")

    console.log(JSON.stringify({ success: true, data: group }, null, 2))

    console.error("")
    console.error(formatSuccess(`Added ${emails.length} email(s) to group '${name}'`))
    console.error(`  Total emails: ${group.emails.length}`)
    console.error("")

    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}

export async function removeFromGroupCommand(name: string, options: ModifyGroupOptions): Promise<void> {
  const spinner = ora()

  try {
    if (!options.email) {
      console.error(chalk.red("Please specify --email to remove"))
      process.exit(1)
    }

    const client = new SiteioClient()
    const emails = options.email.split(",").map((e) => e.trim())

    spinner.start(`Removing emails from group ${name}`)
    const group = await client.removeEmailsFromGroup(name, emails)
    spinner.succeed("Emails removed")

    console.log(JSON.stringify({ success: true, data: group }, null, 2))

    console.error("")
    console.error(formatSuccess(`Removed ${emails.length} email(s) from group '${name}'`))
    console.error(`  Remaining emails: ${group.emails.length}`)
    console.error("")

    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
