import ora from "ora"
import chalk from "chalk"
import { SiteioClient } from "../lib/client.ts"
import { formatSuccess } from "../utils/output.ts"
import { handleError } from "../utils/errors.ts"

export async function listGroupsCommand(options: { json?: boolean } = {}): Promise<void> {
  const spinner = ora()

  try {
    const client = new SiteioClient()

    spinner.start("Fetching groups")
    const groups = await client.listGroups()
    spinner.stop()

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: groups }, null, 2))
    } else if (groups.length === 0) {
      console.log(chalk.gray("No groups defined"))
    } else {
      console.log("")
      console.log(chalk.bold("Groups:"))
      for (const group of groups) {
        console.log(`  ${chalk.cyan(group.name)} (${group.emails.length} emails)`)
      }
      console.log("")
    }

    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}

export async function showGroupCommand(name: string, options: { json?: boolean } = {}): Promise<void> {
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

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: group }, null, 2))
    } else {
      console.log("")
      console.log(chalk.bold(`Group: ${group.name}`))
      if (group.emails.length === 0) {
        console.log(chalk.gray("  No emails in this group"))
      } else {
        console.log("  Emails:")
        for (const email of group.emails) {
          console.log(`    - ${chalk.cyan(email)}`)
        }
      }
      console.log("")
    }

    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}

export interface CreateGroupOptions {
  emails?: string
  json?: boolean
}

export async function createGroupCommand(name: string, options: CreateGroupOptions): Promise<void> {
  const spinner = ora()

  try {
    const client = new SiteioClient()

    const emails = options.emails ? options.emails.split(",").map((e) => e.trim()) : []

    spinner.start(`Creating group ${name}`)
    const group = await client.createGroup(name, emails)
    spinner.succeed("Group created")

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: group }, null, 2))
    } else {
      console.log("")
      console.log(formatSuccess(`Group '${group.name}' created`))
      if (group.emails.length > 0) {
        console.log(`  Emails: ${chalk.cyan(group.emails.join(", "))}`)
      }
      console.log("")
    }

    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}

export async function deleteGroupCommand(name: string, options: { json?: boolean } = {}): Promise<void> {
  const spinner = ora()

  try {
    const client = new SiteioClient()

    spinner.start(`Deleting group ${name}`)
    await client.deleteGroup(name)
    spinner.succeed("Group deleted")

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: null }, null, 2))
    } else {
      console.log("")
      console.log(formatSuccess(`Group '${name}' deleted`))
      console.log("")
    }

    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}

export interface ModifyGroupOptions {
  email?: string
  json?: boolean
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

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: group }, null, 2))
    } else {
      console.log("")
      console.log(formatSuccess(`Added ${emails.length} email(s) to group '${name}'`))
      console.log(`  Total emails: ${group.emails.length}`)
      console.log("")
    }

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

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: group }, null, 2))
    } else {
      console.log("")
      console.log(formatSuccess(`Removed ${emails.length} email(s) from group '${name}'`))
      console.log(`  Remaining emails: ${group.emails.length}`)
      console.log("")
    }

    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
