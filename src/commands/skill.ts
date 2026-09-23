import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import ora from "ora"
import chalk from "chalk"
import { APPS_SKILL, SITES_SKILL, SKILL_CONTENT } from "../lib/skill-content.ts"
import { formatSuccess } from "../utils/output.ts"
import { handleError, ValidationError } from "../utils/errors.ts"
import { select } from "../utils/prompt.ts"

type SkillScope = "user" | "project"

// Where the skill is written. `.agents/skills/` is the cross-agent convention
// (Codex, Cursor, Gemini CLI, Copilot, Amp, Cline, OpenCode, Warp, ...);
// Claude Code reads only its own `.claude/skills/`, so it needs its own copy.
// Both hold the same SKILL.md — an install refreshes every target.
interface SkillTarget {
  // Directory holding the per-scope skill roots, relative to the scope base.
  dir: string
  // Agents that pick the skill up from here, for the human-facing summary.
  agents: string
}

const TARGETS: SkillTarget[] = [
  { dir: join(".agents", "skills"), agents: "Codex, Cursor, Gemini CLI, Copilot, Amp, OpenCode, Warp" },
  { dir: join(".claude", "skills"), agents: "Claude Code" },
]

export function scopeBase(scope: SkillScope): string {
  return scope === "user" ? homedir() : process.cwd()
}

function skillDir(base: string, target: SkillTarget): string {
  return join(base, target.dir, "siteio")
}

function skillFile(base: string, target: SkillTarget): string {
  return join(skillDir(base, target), "SKILL.md")
}

export interface InstalledSkill {
  path: string
  agents: string
}

// Write SKILL.md to every target under `base`, creating directories as needed.
// Separated from the command so it is testable without process.exit.
export function writeSkillTo(base: string): InstalledSkill[] {
  return TARGETS.map((target) => {
    const dir = skillDir(base, target)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = skillFile(base, target)
    writeFileSync(file, SKILL_CONTENT, "utf-8")
    return { path: file, agents: target.agents }
  })
}

// Remove every installed target under `base`; returns the files that existed.
export function removeSkillFrom(base: string): string[] {
  const removed: string[] = []
  for (const target of TARGETS) {
    const file = skillFile(base, target)
    if (!existsSync(file)) continue
    rmSync(skillDir(base, target), { recursive: true, force: true })
    removed.push(file)
  }
  return removed
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
      { value: "user", label: `user    (${homedir()}, available in all projects)` },
      { value: "project", label: `project (${process.cwd()}, this project only)` },
    ])
  }

  return "user"
}

// The overview (`siteio skill`, also what gets installed) points agents at the
// per-kind guides, so each agent loads only the half it needs.
export const SKILLS = {
  siteio: SKILL_CONTENT,
  "siteio-sites": SITES_SKILL,
  "siteio-apps": APPS_SKILL,
} as const

export type SkillName = keyof typeof SKILLS

// Print a skill to stdout. This is the agent-facing path: an agent already
// running siteio needs the instructions in its context now, not a file on disk
// it would have to be restarted to discover. Works for any agent, including
// those that implement no skill standard at all.
export function showSkillCommand(name: SkillName, options: { json?: boolean } = {}): void {
  const content = SKILLS[name]
  if (options.json) {
    console.log(JSON.stringify({ success: true, data: { name, content } }, null, 2))
  } else {
    console.log(content)
  }
  process.exit(0)
}

export async function installSkillCommand(options: { json?: boolean; scope?: string }): Promise<void> {
  const spinner = ora()

  try {
    const scope = await resolveScope(options)

    spinner.start(`Installing siteio skill (${scope} scope)`)

    const installed = writeSkillTo(scopeBase(scope))

    spinner.succeed("Skill installed")

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: { scope, installed } }, null, 2))
    } else {
      console.log("")
      console.log(formatSuccess(`siteio skill installed (${scope} scope)`))
      console.log("")
      for (const { path, agents } of installed) {
        console.log(`  ${chalk.cyan(path)}`)
        console.log(`  ${chalk.dim(agents)}`)
        console.log("")
      }
      console.log(chalk.dim("Agents will load the skill on their next start."))
      console.log(chalk.dim("Any agent can also read it now with: siteio skill (then siteio sites skill / siteio apps skill)"))
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
      scopes = ["user", "project"]
    }

    spinner.start("Uninstalling siteio skill")

    const removed = scopes.flatMap((scope) =>
      removeSkillFrom(scopeBase(scope)).map((path) => ({ scope, path }))
    )

    if (removed.length === 0) {
      spinner.stop()
      if (options.json) {
        console.log(JSON.stringify({ success: true, data: { message: "Skill not installed" } }, null, 2))
      } else {
        console.log(chalk.yellow("Skill is not installed"))
      }
      process.exit(0)
    }

    spinner.succeed("Skill uninstalled")

    if (options.json) {
      console.log(JSON.stringify({ success: true, data: { removed } }, null, 2))
    } else {
      console.log("")
      for (const r of removed) {
        console.log(formatSuccess(`Removed ${r.path}`))
      }
      console.log("")
    }

    process.exit(0)
  } catch (err) {
    spinner.stop()
    handleError(err)
  }
}
