// src/__tests__/unit/skill.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { APPS_SKILL, SITES_SKILL, SKILL_CONTENT } from "../../lib/skill-content.ts"
import { POCKETBASE_JS_SDK_VERSION, POCKETBASE_VERSION } from "../../lib/pocketbase-version.ts"
import { writeSkillTo, removeSkillFrom } from "../../commands/skill.ts"

const AGENTS_SKILL = join(".agents", "skills", "siteio", "SKILL.md")
const CLAUDE_SKILL = join(".claude", "skills", "siteio", "SKILL.md")

describe("Unit: agent skill", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "siteio-skill-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe("SKILL.md content", () => {
    // The Agent Skills standard requires only `name` and `description`, and the
    // description is what every agent matches on to decide whether to activate.
    test("opens with frontmatter carrying the two required fields", () => {
      expect(SKILL_CONTENT.startsWith("---\n")).toBe(true)
      const end = SKILL_CONTENT.indexOf("\n---", 4)
      expect(end).toBeGreaterThan(0)
      const frontmatter = SKILL_CONTENT.slice(4, end)
      expect(frontmatter).toMatch(/^name: siteio$/m)
      expect(frontmatter).toMatch(/^description: \S/m)
    })

    // `name` must match the containing folder, which is what writeSkillTo creates.
    test("name matches the directory the skill is installed into", () => {
      const name = SKILL_CONTENT.match(/^name: (.+)$/m)?.[1]
      expect(name).toBe("siteio")
      writeSkillTo(dir)
      expect(existsSync(join(dir, ".agents", "skills", name!, "SKILL.md"))).toBe(true)
    })

    test("tells the agent to check syntax with --help rather than guess", () => {
      for (const content of [SKILL_CONTENT, SITES_SKILL, APPS_SKILL]) expect(content).toContain("--help")
    })

    // Agents mix up the two command groups unless the distinction comes first.
    test("the overview introduces sites and apps as two distinct kinds before any section", () => {
      const intro = SKILL_CONTENT.slice(0, SKILL_CONTENT.indexOf("\n## "))
      expect(intro).toContain("siteio sites")
      expect(intro).toContain("siteio apps")
      expect(intro).toContain("PocketBase")
      expect(intro).toContain("Docker")
      const frontmatter = SKILL_CONTENT.slice(4, SKILL_CONTENT.indexOf("\n---", 4))
      expect(frontmatter).toMatch(/^description: .*\bsite\b.*\bapp\b/m)
    })

    test("the overview points to both detailed guides and stays an overview", () => {
      expect(SKILL_CONTENT).toContain("siteio sites skill")
      expect(SKILL_CONTENT).toContain("siteio apps skill")
      // Details belong in the per-kind guides, not the always-loaded overview.
      for (const detail of ["pb_migrations", "sites share", "pocketbase.io/docs", "apps create", "apps set"]) {
        expect(SKILL_CONTENT).not.toContain(detail)
      }
    })

    test("each guide covers only its own kind", () => {
      expect(SITES_SKILL).not.toContain("siteio apps")
      expect(APPS_SKILL).not.toContain("siteio sites")
      expect(SITES_SKILL.startsWith("# siteio sites")).toBe(true)
      expect(APPS_SKILL.startsWith("# siteio apps")).toBe(true)
    })

    // Printed guides are not installed skills: frontmatter would only be noise.
    test("the guides carry no frontmatter", () => {
      expect(SITES_SKILL.startsWith("---")).toBe(false)
      expect(APPS_SKILL.startsWith("---")).toBe(false)
    })

    // `apps create` only registers an app; without `apps deploy` nothing runs.
    test("the apps quick start deploys after creating", () => {
      const create = APPS_SKILL.indexOf("siteio apps create")
      expect(create).toBeGreaterThan(0)
      expect(APPS_SKILL.indexOf("siteio apps deploy", create)).toBeGreaterThan(create)
    })

    // The skill ships inside the binary, so the versions it states must be the
    // ones this build pins, never a stale literal.
    test("the sites guide states exactly the PocketBase and JS SDK versions this build pins", () => {
      expect(SITES_SKILL).toContain(`PocketBase ${POCKETBASE_VERSION}`)
      expect(SITES_SKILL).toContain(`JS SDK\n${POCKETBASE_JS_SDK_VERSION}`)
      const semvers = new Set(SITES_SKILL.match(/\b\d+\.\d+\.\d+\b/g) ?? [])
      expect([...semvers].sort()).toEqual([POCKETBASE_JS_SDK_VERSION, POCKETBASE_VERSION].sort())
      for (const other of [SKILL_CONTENT, APPS_SKILL]) expect(other).not.toMatch(/\b\d+\.\d+\.\d+\b/)
    })

    test("versioned doc links are pinned to this build's tags, not a branch", () => {
      const links = SITES_SKILL.match(/https:\/\/raw\.githubusercontent\.com\/\S+/g) ?? []
      expect(links).toContain(`https://raw.githubusercontent.com/pocketbase/js-sdk/v${POCKETBASE_JS_SDK_VERSION}/README.md`)
      expect(links).toContain(`https://raw.githubusercontent.com/pocketbase/pocketbase/v${POCKETBASE_VERSION}/CHANGELOG.md`)
      for (const link of links) expect(link).not.toMatch(/\/(master|main|HEAD)\//)
    })

    test("warns that a deployed site can run a different PocketBase than the CLI", () => {
      expect(SITES_SKILL).toContain("siteio sites list")
      expect(SITES_SKILL).toMatch(/existing site may still\s+run an older one/)
    })
  })

  // The commands the overview tells agents to run must exist and print exactly
  // the matching guide — a typo here would strand every agent at the overview.
  describe("print commands", () => {
    const cli = (...args: string[]) => {
      const r = Bun.spawnSync({ cmd: ["bun", "run", join(import.meta.dir, "../../cli.ts"), ...args], stdout: "pipe", stderr: "pipe" })
      return { code: r.exitCode, out: r.stdout.toString() }
    }
    // Every flag the apps guide shows must exist on that command, or agents
    // follow the guide into "unknown option" errors.
    test("every flag in the apps guide's examples exists on its command", () => {
      const flagsByCommand = new Map<string, Set<string>>()
      for (const [, command, rest] of APPS_SKILL.matchAll(/siteio apps ([a-z]+)([^`\n]*)/g)) {
        const flags = flagsByCommand.get(command!) ?? new Set<string>()
        for (const [flag] of rest!.matchAll(/--[a-z][a-z-]*/g)) flags.add(flag)
        flagsByCommand.set(command!, flags)
      }
      expect(flagsByCommand.get("create")?.has("--compose-file")).toBe(true)
      for (const [command, flags] of flagsByCommand) {
        const help = cli("apps", command, "--help").out
        for (const flag of flags) expect(`${command} ${flag}: ${help.includes(flag)}`).toBe(`${command} ${flag}: true`)
      }
    })

    test.each([
      [["skill"], SKILL_CONTENT],
      [["sites", "skill"], SITES_SKILL],
      [["apps", "skill"], APPS_SKILL],
    ] as const)("siteio %p prints its guide", (args, expected) => {
      const { code, out } = cli(...args)
      expect(code).toBe(0)
      expect(out).toBe(expected + "\n")
    })

    test("--json wraps each guide with its name", () => {
      const { out } = cli("--json", "sites", "skill")
      expect(JSON.parse(out)).toEqual({ success: true, data: { name: "siteio-sites", content: SITES_SKILL } })
    })

    test("install writes only the overview, not the guides", () => {
      const installed = writeSkillTo(dir)
      for (const { path } of installed) {
        const content = readFileSync(path, "utf-8")
        expect(content).toBe(SKILL_CONTENT)
        expect(content).not.toContain(SITES_SKILL)
      }
    })
  })

  describe("install", () => {
    test("writes the shared cross-agent path and Claude Code's own path", () => {
      const installed = writeSkillTo(dir)

      expect(existsSync(join(dir, AGENTS_SKILL))).toBe(true)
      expect(existsSync(join(dir, CLAUDE_SKILL))).toBe(true)
      expect(readFileSync(join(dir, AGENTS_SKILL), "utf-8")).toBe(SKILL_CONTENT)
      expect(readFileSync(join(dir, CLAUDE_SKILL), "utf-8")).toBe(SKILL_CONTENT)

      expect(installed.map((i) => i.path)).toEqual([join(dir, AGENTS_SKILL), join(dir, CLAUDE_SKILL)])
      // Every target names the agents it serves, for the install summary.
      expect(installed.every((i) => i.agents.length > 0)).toBe(true)
    })

    test("refreshes a stale copy rather than leaving it behind", () => {
      const file = join(dir, AGENTS_SKILL)
      mkdirSync(join(dir, ".agents", "skills", "siteio"), { recursive: true })
      writeFileSync(file, "stale content")

      writeSkillTo(dir)
      expect(readFileSync(file, "utf-8")).toBe(SKILL_CONTENT)
    })
  })

  describe("uninstall", () => {
    test("removes every installed target", () => {
      writeSkillTo(dir)
      const removed = removeSkillFrom(dir)

      expect(removed).toEqual([join(dir, AGENTS_SKILL), join(dir, CLAUDE_SKILL)])
      expect(existsSync(join(dir, AGENTS_SKILL))).toBe(false)
      expect(existsSync(join(dir, CLAUDE_SKILL))).toBe(false)
    })

    test("reports nothing when the skill was never installed", () => {
      expect(removeSkillFrom(dir)).toEqual([])
    })

    test("removes only what is present when a target was deleted by hand", () => {
      writeSkillTo(dir)
      rmSync(join(dir, ".agents"), { recursive: true, force: true })

      expect(removeSkillFrom(dir)).toEqual([join(dir, CLAUDE_SKILL)])
    })

    // The skill lives in its own `siteio` directory, so removing it must never
    // take the agent's other skills with it.
    test("leaves other skills in the same directory untouched", () => {
      writeSkillTo(dir)
      const other = join(dir, ".agents", "skills", "other", "SKILL.md")
      mkdirSync(join(dir, ".agents", "skills", "other"), { recursive: true })
      writeFileSync(other, "other skill")

      removeSkillFrom(dir)
      expect(existsSync(other)).toBe(true)
    })
  })
})
