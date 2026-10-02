import { describe, expect, test } from "bun:test"
import { validateCreateOptions } from "../../commands/apps/create"
import { buildGitPatch } from "../../commands/apps/set"
import { formatAutoDeploy } from "../../commands/apps/info"
import { ValidationError } from "../../utils/errors"
import type { GitSource } from "../../types"

const GIT: GitSource = { repoUrl: "https://x.test/r.git", branch: "main", dockerfile: "Dockerfile" }
const NOW = Date.parse("2026-10-02T12:00:00.000Z")

describe("create --auto-deploy", () => {
  test.each(["off", "commit", "tag"])("accepts %s with --git", (mode) => {
    expect(() => validateCreateOptions({ git: GIT.repoUrl, autoDeploy: mode })).not.toThrow()
  })

  test("rejects an unknown value", () => {
    expect(() => validateCreateOptions({ git: GIT.repoUrl, autoDeploy: "weekly" })).toThrow(
      "Invalid --auto-deploy value: weekly. Valid values: off, commit, tag"
    )
  })

  test("rejects an empty value instead of treating it as off", () => {
    expect(() => validateCreateOptions({ git: GIT.repoUrl, autoDeploy: "" })).toThrow(ValidationError)
  })

  test.each([
    [{ image: "nginx" }, "--auto-deploy requires --git"],
    [{ file: "/tmp/Dockerfile" }, "--auto-deploy requires --git"],
    [{ composeFile: "/tmp/dc.yml", service: "web" }, "--auto-deploy requires --git"],
    [{ git: GIT.repoUrl, compose: "dc.yml", service: "web" }, "not supported for compose apps"],
  ])("rejects %p", (options, message) => {
    expect(() => validateCreateOptions({ ...options, autoDeploy: "tag" })).toThrow(message)
  })
})

describe("set --auto-deploy", () => {
  test("builds a patch with only the mode", () => {
    expect(buildGitPatch({ git: GIT }, { autoDeploy: "tag" })).toEqual({ autoDeploy: "tag" })
  })

  test("combines with --dockerfile and --git-token", () => {
    expect(buildGitPatch({ git: GIT }, { autoDeploy: "commit", dockerfile: "D2", gitToken: "t" })).toEqual({
      autoDeploy: "commit",
      dockerfile: "D2",
      token: "t",
    })
  })

  test("an empty --git-token still clears the token", () => {
    expect(buildGitPatch({ git: GIT }, { gitToken: "" })).toEqual({ token: undefined })
  })

  test("rejects a non-git app", () => {
    expect(() => buildGitPatch({}, { autoDeploy: "tag" })).toThrow("non-git app")
  })

  test("rejects a compose app", () => {
    expect(() =>
      buildGitPatch({ git: GIT, compose: { source: "git", path: "dc.yml", primaryService: "web" } }, { autoDeploy: "tag" })
    ).toThrow("not supported for compose apps")
  })

  test("a compose app can still change its git token", () => {
    expect(
      buildGitPatch({ git: GIT, compose: { source: "git", path: "dc.yml", primaryService: "web" } }, { gitToken: "t" })
    ).toEqual({ token: "t" })
  })

  test("rejects an unknown value", () => {
    expect(() => buildGitPatch({ git: GIT }, { autoDeploy: "always" })).toThrow("Invalid --auto-deploy value")
  })
})

describe("formatAutoDeploy", () => {
  test("tag mode shows the tag and the age of the last check", () => {
    const text = formatAutoDeploy(
      { git: { ...GIT, autoDeploy: "tag" }, autoDeployRef: "v3.8.2", autoDeployCheckedAt: "2026-10-02T11:58:00.000Z" },
      NOW
    )
    expect(text).toBe("tag (last v3.8.2, checked 2 min ago)")
  })

  test("commit mode shortens the SHA", () => {
    const text = formatAutoDeploy(
      { git: { ...GIT, autoDeploy: "commit" }, autoDeployRef: "f4a8df3" + "0".repeat(33), autoDeployCheckedAt: "2026-10-02T11:59:50.000Z" },
      NOW
    )
    expect(text).toBe("commit (last f4a8df3, checked just now)")
  })

  test("before the first check", () => {
    expect(formatAutoDeploy({ git: { ...GIT, autoDeploy: "tag" } }, NOW)).toBe("tag (last none yet, not checked yet)")
  })

  test("hours and days", () => {
    const at = (iso: string) => formatAutoDeploy({ git: { ...GIT, autoDeploy: "tag" }, autoDeployCheckedAt: iso }, NOW)
    expect(at("2026-10-02T09:00:00.000Z")).toContain("checked 3 h ago")
    expect(at("2026-09-29T12:00:00.000Z")).toContain("checked 3 d ago")
  })

  test("a corrupt or future timestamp does not print NaN or a negative age", () => {
    const at = (iso: string) => formatAutoDeploy({ git: { ...GIT, autoDeploy: "tag" }, autoDeployCheckedAt: iso }, NOW)
    expect(at("not a date")).toContain("checked at an unknown time")
    expect(at("2030-01-01T00:00:00.000Z")).toContain("checked just now")
  })
})

describe("set --git", () => {
  test("builds a patch with only the new repository", () => {
    expect(buildGitPatch({ git: GIT }, { git: "https://github.com/user/renamed" })).toEqual({
      repoUrl: "https://github.com/user/renamed",
    })
  })

  test("trims the URL, so a pasted trailing newline is not stored", () => {
    expect(buildGitPatch({ git: GIT }, { git: "  https://github.com/user/renamed\n" })).toEqual({
      repoUrl: "https://github.com/user/renamed",
    })
  })

  test.each(["", "   ", "\n"])("refuses an empty URL (%p) instead of breaking the next deploy", (url) => {
    expect(() => buildGitPatch({ git: GIT }, { git: url })).toThrow("--git needs a repository URL")
  })

  test("refuses an app that is not built from git", () => {
    expect(() => buildGitPatch({}, { git: "https://github.com/user/renamed" })).toThrow("non-git app")
  })

  test("combines with --git-token, for a move to a private repository", () => {
    expect(buildGitPatch({ git: GIT }, { git: "https://github.com/user/private", gitToken: "t" })).toEqual({
      repoUrl: "https://github.com/user/private",
      token: "t",
    })
  })
})
