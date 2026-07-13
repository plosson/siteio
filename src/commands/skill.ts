import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import ora from "ora"
import chalk from "chalk"
import { SKILL_CONTENT } from "../lib/skill-content.ts"
import { formatSuccess } from "../utils/output.ts"
import { handleError, ValidationError } from "../utils/errors.ts"
import { select } from "../utils/prompt.ts"

type SkillScope = "user" | "project"

function skillDir(scope: SkillScope): string {
  const base = scope === "user" ? homedir() : process.cwd()
  return join(base, ".claude", "skills", "siteio")
}

function skillFile(scope: SkillScope): string {
  return join(skillDir(scope), "SKILL.md")
}

async function resolveScope(options: { scope?: string; json?: boolean }): Promise<SkillScope> {
  if (options.scope) {
    if (options.scope !== "user" && options.scope !== "project") {
      throw new ValidationError(`Invalid scope: ${options.scope}. Must be "user" or "project"`)
    }
    return options.scope
  }

  // Interactive prompt when possible, otherwise default to user scope
  if (!options.json && process.stdin.isTTY) {
    return select<SkillScope>("Where should the skill be installed?", [
      { value: "user", label: `user    (${join(homedir(), ".claude")}, available in all projects)` },
      { value: "project", label: `project (${join(process.cwd(), ".claude")}, this project only)` },
    ])
  }

  return "user"
}

export async function installSkillCommand(options: { json?: boolean; scope?: string }): Promise<void> {
  const spinner = ora()

  try {
    const scope = await resolveScope(options)
    const dir = skillDir(scope)
    const file = skillFile(scope)

    spinner.start(`Installing siteio skill for Claude Code (${scope} scope)`)

    // Create directory if it doesn't exist
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    // Write the skill file
    writeFileSync(file, SKILL_CONTENT, "utf-8")

    spinner.succeed("Skill installed")

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: { scope, path: file } }, null, 2))
    } else {
      console.log("")
      console.log(formatSuccess(`siteio skill installed for Claude Code (${scope} scope)`))
      console.log("")
      console.log(`  Location: ${chalk.cyan(file)}`)
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

export async function uninstallSkillCommand(options: { json?: boolean; scope?: string }): Promise<void> {
  const spinner = ora()

  try {
    let scopes: SkillScope[]
    if (options.scope) {
      if (options.scope !== "user" && options.scope !== "project") {
        throw new ValidationError(`Invalid scope: ${options.scope}. Must be "user" or "project"`)
      }
      scopes = [options.scope]
    } else {
      // No scope given: remove from wherever it is installed
      scopes = (["user", "project"] as SkillScope[]).filter((s) => existsSync(skillFile(s)))
    }

    const installed = scopes.filter((s) => existsSync(skillFile(s)))

    if (installed.length === 0) {
      if (options.json) {
        console.log(JSON.stringify({ success: true, data: { message: "Skill not installed" } }, null, 2))
      } else {
        console.log(chalk.yellow("Skill is not installed"))
      }
      process.exit(0)
    }

    spinner.start("Uninstalling siteio skill")

    const removed = installed.map((scope) => {
      rmSync(skillDir(scope), { recursive: true, force: true })
      return { scope, path: skillFile(scope) }
    })

    spinner.succeed("Skill uninstalled")

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: { removed } }, null, 2))
    } else {
      console.log("")
      for (const r of removed) {
        console.log(formatSuccess(`siteio skill removed from Claude Code (${r.scope} scope)`))
      }
      console.log("")
    }

    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
