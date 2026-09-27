import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })))

test("provider credentials stay private, survive login/logout writes, and env overrides stored tokens", () => {
  const home = mkdtempSync(join(tmpdir(), "siteio-config-")); dirs.push(home)
  const env = { ...process.env, HOME: home, HETZNER_TOKEN: "", HCLOUD_TOKEN: "", CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_TOKEN: "" }
  const cli = resolve("src/cli.ts")
  const token = "secret-provider-token"
  const set = Bun.spawnSync(["bun", cli, "--json", "config", "set", "hetznerToken", token], { env })
  expect(set.exitCode).toBe(0)
  expect(set.stdout.toString() + set.stderr.toString()).not.toContain(token)
  const get = Bun.spawnSync(["bun", cli, "config", "get", "hetznerToken"], { env })
  expect(get.stdout.toString().trim()).toBe("********")
  const code = `import { addServer, removeServer, getProviderToken, setUsername } from ${JSON.stringify(resolve("src/config/loader.ts"))};
    setUsername("alice"); addServer("https://api.test.org", "agent-key"); removeServer("test.org");
    console.log(getProviderToken("hetznerToken"));`
  const update = Bun.spawnSync(["bun", "-e", code], { env: { ...env, HETZNER_TOKEN: "env-token" } })
  expect(update.exitCode).toBe(0)
  expect(update.stdout.toString().trim()).toBe("env-token")
  const path = join(home, ".config/siteio/config.json")
  const saved = JSON.parse(readFileSync(path, "utf8"))
  expect(saved.hetznerToken).toBe(token)
  expect(saved.username).toBe("alice")
  expect(statSync(path).mode & 0o777).toBe(0o600)
})

test("server CLI exposes create/destroy and refuses missing configuration before network access", () => {
  const home = mkdtempSync(join(tmpdir(), "siteio-config-")); dirs.push(home)
  const env = { ...process.env, HOME: home, HETZNER_TOKEN: "", HCLOUD_TOKEN: "" }
  const cli = resolve("src/cli.ts")
  const help = Bun.spawnSync(["bun", cli, "server", "--help"], { env })
  expect(help.stdout.toString()).toContain("create")
  expect(help.stdout.toString()).toContain("destroy")
  const create = Bun.spawnSync(["bun", cli, "server", "create", "box", "--sslip", "--email", "me@test.org"], { env })
  expect(create.exitCode).not.toBe(0)
  expect(create.stderr.toString()).toContain("hetznerToken")
})

test("remote agent install with flags runs without configuration prompts and quotes arguments", () => {
  const home = mkdtempSync(join(tmpdir(), "siteio-install-")); dirs.push(home)
  const ssh = join(home, "ssh")
  // Stub the SSH executable only; exercise the real CLI and remote install flow.
  const script = `#!/bin/sh
for last do :; done
case "$last" in
  *ipify*) echo 192.0.2.1 ;;
  *which*) echo /usr/local/bin/siteio ;;
  *) printf '%s' "$last" > "$HOME/remote-command" ;;
esac
`
  writeFileSync(ssh, script, { mode: 0o700 })
  const result = Bun.spawnSync(["bun", resolve("src/cli.ts"), "agent", "install", "root@192.0.2.1",
    "--domain", "test.org", "--email", "me@test.org", "--data-dir", "/data with space"],
    { env: { ...process.env, HOME: home, PATH: `${home}:${process.env.PATH}` }, stdin: "pipe" })
  expect(result.exitCode).toBe(0)
  const command = readFileSync(join(home, "remote-command"), "utf8")
  expect(command).toContain("--domain 'test.org'")
  expect(command).toContain("--data-dir '/data with space'")
  expect(command).toContain("--email 'me@test.org'")
})
