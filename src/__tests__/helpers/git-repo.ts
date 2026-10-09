import { mkdirSync, symlinkSync, writeFileSync } from "fs"
import { join } from "path"

const GIT_ENV = {
  ...(process.env as Record<string, string>),
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
}

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe", env: GIT_ENV })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

export interface TestRepo {
  url: string // file:// URL of the bare remote
  work: string
  bare: string
  commit(message: string): string // returns the new HEAD SHA
  symlink(path: string, target: string): void // commits a symlink at path pointing to target
  tag(name: string, annotated?: boolean): void
  push(): void // pushes main and all tags to the bare remote
}

/** A work repo with one commit holding a Dockerfile, and a bare remote. */
export function makeRepo(root: string): TestRepo {
  const work = join(root, "work")
  const bare = join(root, "remote.git")
  mkdirSync(work, { recursive: true })
  git(work, "init", "-q", "-b", "main")
  writeFileSync(join(work, "Dockerfile"), "FROM scratch\n")
  git(work, "add", ".")
  git(work, "commit", "-q", "-m", "initial")
  git(root, "init", "-q", "--bare", bare)

  const repo: TestRepo = {
    url: `file://${bare}`,
    work,
    bare,
    commit(message) {
      writeFileSync(join(work, "CHANGES"), `${message}\n`, { flag: "a" })
      git(work, "add", ".")
      git(work, "commit", "-q", "-m", message)
      return git(work, "rev-parse", "HEAD")
    },
    symlink(path, target) {
      symlinkSync(target, join(work, path))
      git(work, "add", ".")
      git(work, "commit", "-q", "-m", `link ${path}`)
    },
    tag(name, annotated = false) {
      if (annotated) git(work, "tag", "-a", name, "-m", name)
      else git(work, "tag", name)
    },
    push() {
      git(work, "push", "-q", bare, "main", "--tags")
    },
  }
  repo.push()
  return repo
}
