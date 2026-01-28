import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { homedir } from "os"
import ora from "ora"
import chalk from "chalk"
import { SKILL_CONTENT } from "../lib/skill-content.ts"
import { formatSuccess } from "../utils/output.ts"
import { handleError } from "../utils/errors.ts"

const SKILL_DIR = join(homedir(), ".claude", "skills", "siteio")
const SKILL_FILE = join(SKILL_DIR, "SKILL.md")

export async function installSkillCommand(options: { json?: boolean }): Promise<void> {
  const spinner = ora()

  try {
    spinner.start("Installing siteio skill for Claude Code")

    // Create directory if it doesn't exist
    if (!existsSync(SKILL_DIR)) {
      mkdirSync(SKILL_DIR, { recursive: true })
    }

    // Write the skill file
    writeFileSync(SKILL_FILE, SKILL_CONTENT, "utf-8")

    spinner.succeed("Skill installed")

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: { path: SKILL_FILE } }, null, 2))
    } else {
      console.log("")
      console.log(formatSuccess("siteio skill installed for Claude Code"))
      console.log("")
      console.log(`  Location: ${chalk.cyan(SKILL_FILE)}`)
      console.log("")
      console.log(chalk.dim("Claude Code will now be able to deploy sites using siteio."))
      console.log("")
    }

    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}

export async function uninstallSkillCommand(options: { json?: boolean }): Promise<void> {
  const spinner = ora()

  try {
    if (!existsSync(SKILL_FILE)) {
      if (options.json) {
        console.log(JSON.stringify({ success: true, data: { message: "Skill not installed" } }, null, 2))
      } else {
        console.log(chalk.yellow("Skill is not installed"))
      }
      process.exit(0)
    }

    spinner.start("Uninstalling siteio skill")

    // Remove the skill directory
    rmSync(SKILL_DIR, { recursive: true, force: true })

    spinner.succeed("Skill uninstalled")

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: { path: SKILL_FILE } }, null, 2))
    } else {
      console.log("")
      console.log(formatSuccess("siteio skill removed from Claude Code"))
      console.log("")
    }

    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
