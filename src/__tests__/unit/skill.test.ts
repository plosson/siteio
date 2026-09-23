// src/__tests__/unit/skill.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { SKILL_CONTENT } from "../../lib/skill-content.ts"
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
      expect(SKILL_CONTENT).toContain("--help")
    })

    // Agents mix up the two command groups unless the distinction comes first.
    test("introduces sites and apps as two distinct kinds before any command section", () => {
      const intro = SKILL_CONTENT.slice(0, SKILL_CONTENT.indexOf("\n## "))
      expect(intro).toContain("siteio sites")
      expect(intro).toContain("siteio apps")
      expect(intro).toContain("PocketBase")
      expect(intro).toContain("Docker")
      const frontmatter = SKILL_CONTENT.slice(4, SKILL_CONTENT.indexOf("\n---", 4))
      expect(frontmatter).toMatch(/^description: .*\bsite\b.*\bapp\b/m)
    })

    test("site commands live under the Sites section and app commands under Apps", () => {
      const sites = SKILL_CONTENT.indexOf("\n## Sites (PocketBase)")
      const apps = SKILL_CONTENT.indexOf("\n## Apps (Docker)")
      expect(sites).toBeGreaterThan(0)
      expect(apps).toBeGreaterThan(sites)
      expect(SKILL_CONTENT.slice(sites, apps)).not.toContain("siteio apps")
      expect(SKILL_CONTENT.slice(apps)).not.toContain("siteio sites")
    })

    // `apps create` only registers an app; without `apps deploy` nothing runs.
    test("the apps quick start deploys after creating", () => {
      const apps = SKILL_CONTENT.slice(SKILL_CONTENT.indexOf("\n## Apps (Docker)"))
      const create = apps.indexOf("siteio apps create")
      expect(create).toBeGreaterThan(0)
      expect(apps.indexOf("siteio apps deploy", create)).toBeGreaterThan(create)
    })

    // The skill ships inside the binary, so the versions it states must be the
    // ones this build pins, never a stale literal.
    test("states exactly the PocketBase and JS SDK versions this build pins", () => {
      expect(SKILL_CONTENT).toContain(`PocketBase ${POCKETBASE_VERSION}`)
      expect(SKILL_CONTENT).toContain(`JS SDK\n${POCKETBASE_JS_SDK_VERSION}`)
      const semvers = new Set(SKILL_CONTENT.match(/\b\d+\.\d+\.\d+\b/g) ?? [])
      expect([...semvers].sort()).toEqual([POCKETBASE_JS_SDK_VERSION, POCKETBASE_VERSION].sort())
    })

    test("versioned doc links are pinned to this build's tags, not a branch", () => {
      const links = SKILL_CONTENT.match(/https:\/\/raw\.githubusercontent\.com\/\S+/g) ?? []
      expect(links).toContain(`https://raw.githubusercontent.com/pocketbase/js-sdk/v${POCKETBASE_JS_SDK_VERSION}/README.md`)
      expect(links).toContain(`https://raw.githubusercontent.com/pocketbase/pocketbase/v${POCKETBASE_VERSION}/CHANGELOG.md`)
      for (const link of links) expect(link).not.toMatch(/\/(master|main|HEAD)\//)
    })

    test("warns that a deployed site can run a different PocketBase than the CLI", () => {
      expect(SKILL_CONTENT).toContain("siteio sites list")
      expect(SKILL_CONTENT).toMatch(/existing site may still\s+run an older one/)
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
