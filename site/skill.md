# Install the siteio skill

These instructions are for an AI coding agent. Follow them to install siteio and its agent skill. siteio deploys websites and Docker apps to the user's own server.

The skill itself ships inside the siteio CLI, so it always matches the installed version. Do not copy this page into a skill folder. Run the steps below instead.

## 1. Install the CLI

Skip this step if `siteio --version` already works.

```sh
curl -LsSf https://siteio.houlahop.com/install | sh
```

If `siteio` is still not found afterwards, it was installed but is not on the PATH of your shell. Use the full path the installer printed (usually `~/.local/bin/siteio`).

This works on macOS and Linux. On Windows, use WSL.

## 2. Install the skill

```sh
siteio skill install --scope user
```

This writes `SKILL.md` to `~/.agents/skills/siteio/` and `~/.claude/skills/siteio/`, so agents load it in every project from their next start.

If the user wants it only in the current project, use `--scope project` instead.

## 3. Load the skill now

```sh
siteio skill
```

This prints the full instructions. Read them before doing anything else with siteio, because you will not load the installed skill until your next start.

## 4. Tell the user what's next

Run `siteio status`. If it shows siteio is not connected to a server, tell the user they need a connection token from their siteio administrator, then run:

```sh
siteio login -t <token>
```

Do not invent a token or a server address.
