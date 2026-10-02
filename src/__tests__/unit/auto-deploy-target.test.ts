import { describe, expect, test } from "bun:test"
import {
  compareVersions,
  isAutoDeployable,
  isAutoDeployMode,
  parseAutoDeployFlag,
  parseLsRemote,
  parseVersion,
  refPatterns,
  resolveTarget,
  shouldDeploy,
  type RemoteRef,
} from "../../lib/agent/auto-deploy"
import { ValidationError } from "../../utils/errors"

const A = "a".repeat(40)
const B = "b".repeat(40)
const C = "c".repeat(40)
const D = "d".repeat(40)

function tags(...names: string[]): RemoteRef[] {
  return names.map((name, i) => ({ ref: `refs/tags/${name}`, sha: String(i).padStart(40, "0") }))
}

describe("parseVersion", () => {
  test.each(["v0.0.0", "v1.2.3", "v10.20.30"])("accepts %s", (tag) => {
    expect(parseVersion(tag)).not.toBeNull()
  })

  test.each([
    "v1.2", "v1.2.3.4", "v1.2.3-rc1", "v1.2.3+build", "V1.2.3", "1.2.3",
    "v01.2.3", "v1.02.3", "v1.2.03", "v1.2.3 ", " v1.2.3", "v1..3", "v-1.2.3",
    "v1.2.3^{}", "", "v",
  ])("rejects %p", (tag) => {
    expect(parseVersion(tag)).toBeNull()
  })

  test("numbers beyond MAX_SAFE_INTEGER keep their exact value", () => {
    expect(parseVersion("v9007199254740993.0.0")![0]).toBe(9007199254740993n)
  })
})

describe("compareVersions", () => {
  test("compares numbers, not strings", () => {
    expect(compareVersions("v1.10.0", "v1.9.9")).toBe(1)
    expect(compareVersions("v2.0.0", "v1.99.99")).toBe(1)
    expect(compareVersions("v1.2.3", "v1.2.10")).toBe(-1)
    expect(compareVersions("v1.2.3", "v1.2.3")).toBe(0)
  })

  test("huge numbers that round to the same float still compare correctly", () => {
    expect(compareVersions("v9007199254740993.0.0", "v9007199254740992.0.0")).toBe(1)
  })

  test("throws on a non-release tag instead of guessing", () => {
    expect(() => compareVersions("v1.2.3-rc1", "v1.2.3")).toThrow()
  })
})

describe("parseLsRemote", () => {
  test("reads sha<TAB>ref lines and skips everything else", () => {
    const out = [
      `${A}\trefs/heads/main`,
      "",
      "garbage line",
      `nothex${"0".repeat(34)}\trefs/tags/v1.0.0`,
      `${B}\trefs/tags/v1.0.0\textra`,
      `${C}\trefs/tags/v1.0.0`,
      `${D}\trefs/tags/v1.0.0^{}`,
    ].join("\n")
    expect(parseLsRemote(out)).toEqual([
      { ref: "refs/heads/main", sha: A },
      { ref: "refs/tags/v1.0.0", sha: C },
      { ref: "refs/tags/v1.0.0^{}", sha: D },
    ])
  })

  test("accepts SHA-256 object names", () => {
    const sha256 = "e".repeat(64)
    expect(parseLsRemote(`${sha256}\trefs/heads/main`)).toEqual([{ ref: "refs/heads/main", sha: sha256 }])
  })
})

describe("refPatterns", () => {
  test("commit mode asks for the branch only", () => {
    expect(refPatterns("commit", "main")).toEqual(["refs/heads/main"])
  })
  test("tag mode asks for v* tags only", () => {
    expect(refPatterns("tag", "main")).toEqual(["refs/tags/v*"])
  })
})

describe("resolveTarget: commit mode", () => {
  test("returns the branch SHA as both ref and sha", () => {
    expect(resolveTarget("commit", "main", [{ ref: "refs/heads/main", sha: A }])).toEqual({ ref: A, sha: A })
  })

  test("a branch whose name only starts with the tracked one does not count", () => {
    const refs = [{ ref: "refs/heads/main-old", sha: A }, { ref: "refs/heads/feature/main", sha: B }]
    expect(resolveTarget("commit", "main", refs)).toBeNull()
  })

  test("a tag named like the branch does not count", () => {
    expect(resolveTarget("commit", "main", [{ ref: "refs/tags/main", sha: A }])).toBeNull()
  })

  test("empty input", () => {
    expect(resolveTarget("commit", "main", [])).toBeNull()
  })
})

describe("resolveTarget: tag mode", () => {
  test("picks the highest release tag and ignores pre-releases", () => {
    const target = resolveTarget("tag", "main", tags("v1.0.0", "v1.10.0", "v1.9.9", "v2.0.0-rc1", "v3.0", "latest"))
    expect(target?.ref).toBe("v1.10.0")
  })

  test("uses the peeled commit of an annotated tag", () => {
    const refs = [
      { ref: "refs/tags/v1.0.0", sha: A },
      { ref: "refs/tags/v1.0.0^{}", sha: B },
    ]
    expect(resolveTarget("tag", "main", refs)).toEqual({ ref: "v1.0.0", sha: B })
  })

  test("a lightweight tag uses its own SHA", () => {
    expect(resolveTarget("tag", "main", [{ ref: "refs/tags/v1.0.0", sha: A }])).toEqual({ ref: "v1.0.0", sha: A })
  })

  test("a ^{} line alone does not create a tag", () => {
    expect(resolveTarget("tag", "main", [{ ref: "refs/tags/v9.9.9^{}", sha: A }])).toBeNull()
  })

  test("refs outside refs/tags/ are ignored", () => {
    const refs = [{ ref: "refs/heads/v9.9.9", sha: A }, { ref: "refs/pull/1/v9.9.9", sha: B }]
    expect(resolveTarget("tag", "main", refs)).toBeNull()
  })

  test("nested tag names are ignored", () => {
    expect(resolveTarget("tag", "main", [{ ref: "refs/tags/release/v9.9.9", sha: A }])).toBeNull()
  })

  test("no release tag", () => {
    expect(resolveTarget("tag", "main", tags("v1.0.0-rc1", "nightly"))).toBeNull()
  })
})

describe("shouldDeploy", () => {
  test("commit: deploys a SHA that is neither deployed nor already tried", () => {
    expect(shouldDeploy("commit", { commitHash: A }, { ref: B, sha: B })).toBe(true)
  })

  test("commit: skips the deployed SHA", () => {
    expect(shouldDeploy("commit", { commitHash: A }, { ref: A, sha: A })).toBe(false)
  })

  test("commit: skips a SHA already tried, even though it was never deployed", () => {
    expect(shouldDeploy("commit", { commitHash: A, autoDeployRef: B }, { ref: B, sha: B })).toBe(false)
  })

  test("commit: deploys a rewound branch (force-push to an older commit)", () => {
    expect(shouldDeploy("commit", { commitHash: B, autoDeployRef: B }, { ref: A, sha: A })).toBe(true)
  })

  test("tag: first check deploys", () => {
    expect(shouldDeploy("tag", {}, { ref: "v1.0.0", sha: A })).toBe(true)
  })

  test("tag: higher tag deploys", () => {
    expect(shouldDeploy("tag", { autoDeployRef: "v1.9.0" }, { ref: "v1.10.0", sha: A })).toBe(true)
  })

  test("tag: same tag does not deploy", () => {
    expect(shouldDeploy("tag", { autoDeployRef: "v1.10.0" }, { ref: "v1.10.0", sha: A })).toBe(false)
  })

  test("tag: lower tag never deploys (no downgrade)", () => {
    expect(shouldDeploy("tag", { autoDeployRef: "v2.0.0" }, { ref: "v1.10.0", sha: A })).toBe(false)
  })

  test("tag: a stored ref that is not a release tag (left from commit mode) is treated as none", () => {
    expect(shouldDeploy("tag", { autoDeployRef: A }, { ref: "v1.0.0", sha: B })).toBe(true)
  })

  test("tag: the deployed commitHash is irrelevant", () => {
    expect(shouldDeploy("tag", { commitHash: A, autoDeployRef: "v1.0.0" }, { ref: "v1.1.0", sha: A })).toBe(true)
  })
})

describe("isAutoDeployable", () => {
  const git = { repoUrl: "https://x.test/r.git", branch: "main", dockerfile: "Dockerfile" }

  test("git app with commit or tag", () => {
    expect(isAutoDeployable({ git: { ...git, autoDeploy: "commit" } })).toBe(true)
    expect(isAutoDeployable({ git: { ...git, autoDeploy: "tag" } })).toBe(true)
  })

  test("off, missing mode, no git, or compose", () => {
    expect(isAutoDeployable({ git: { ...git, autoDeploy: "off" } })).toBe(false)
    expect(isAutoDeployable({ git })).toBe(false)
    expect(isAutoDeployable({})).toBe(false)
    expect(
      isAutoDeployable({ git: { ...git, autoDeploy: "tag" }, compose: { source: "git", path: "dc.yml", primaryService: "web" } })
    ).toBe(false)
  })

  test("a corrupted mode value in storage is not deployable", () => {
    expect(isAutoDeployable({ git: { ...git, autoDeploy: "weekly" as never } })).toBe(false)
  })
})

describe("mode parsing", () => {
  test.each(["off", "commit", "tag"])("accepts %s", (mode) => {
    expect(isAutoDeployMode(mode)).toBe(true)
    expect(parseAutoDeployFlag(mode)).toBe(mode as never)
  })

  test.each(["", "Tag", "TAG", "tags", "on", "true", "commit ", "__proto__", "constructor"])("rejects %p", (mode) => {
    expect(isAutoDeployMode(mode)).toBe(false)
    expect(() => parseAutoDeployFlag(mode)).toThrow(ValidationError)
  })

  test("non-strings are not modes", () => {
    expect(isAutoDeployMode(undefined)).toBe(false)
    expect(isAutoDeployMode(null)).toBe(false)
    expect(isAutoDeployMode(1)).toBe(false)
    expect(isAutoDeployMode(["tag"])).toBe(false)
  })

  test("the error lists the valid values", () => {
    expect(() => parseAutoDeployFlag("weekly")).toThrow("Valid values: off, commit, tag")
  })
})
