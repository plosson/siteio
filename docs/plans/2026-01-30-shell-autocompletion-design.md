# Shell Autocompletion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add shell autocompletion for bash, zsh, and fish shells.

**Architecture:** Hand-written completion scripts (no external dependencies). The `siteio completion <shell>` command outputs the appropriate script to stdout. The installer auto-installs completions.

**Tech Stack:** Bun, Commander.js, shell scripting (bash/zsh/fish)

---

## Task 1: Create completion command with bash support

**Files:**
- Create: `src/commands/completion.ts`
- Modify: `src/cli.ts`

**Step 1: Create the completion command file**

Create `src/commands/completion.ts`:

```typescript
const BASH_COMPLETION = `
# siteio bash completion
_siteio() {
    local cur prev words cword
    _init_completion || return

    local commands="status login sites apps groups agent update skill completion"
    local sites_cmds="deploy list ls info download rm auth"
    local apps_cmds="create list ls info deploy stop restart rm logs set"
    local groups_cmds="list ls show create delete add remove"
    local agent_cmds="install oauth start stop restart status"
    local skill_cmds="install uninstall"

    if [[ $cword -eq 1 ]]; then
        COMPREPLY=($(compgen -W "$commands" -- "$cur"))
        return
    fi

    case "\${words[1]}" in
        sites)
            if [[ $cword -eq 2 ]]; then
                COMPREPLY=($(compgen -W "$sites_cmds" -- "$cur"))
            fi
            ;;
        apps)
            if [[ $cword -eq 2 ]]; then
                COMPREPLY=($(compgen -W "$apps_cmds" -- "$cur"))
            fi
            ;;
        groups)
            if [[ $cword -eq 2 ]]; then
                COMPREPLY=($(compgen -W "$groups_cmds" -- "$cur"))
            fi
            ;;
        agent)
            if [[ $cword -eq 2 ]]; then
                COMPREPLY=($(compgen -W "$agent_cmds" -- "$cur"))
            fi
            ;;
        skill)
            if [[ $cword -eq 2 ]]; then
                COMPREPLY=($(compgen -W "$skill_cmds" -- "$cur"))
            fi
            ;;
        completion)
            if [[ $cword -eq 2 ]]; then
                COMPREPLY=($(compgen -W "bash zsh fish" -- "$cur"))
            fi
            ;;
    esac
}

complete -F _siteio siteio
`.trim()

export function completionCommand(shell: string): void {
  const validShells = ["bash", "zsh", "fish"]

  if (!validShells.includes(shell)) {
    console.error(\`Invalid shell: \${shell}. Must be one of: \${validShells.join(", ")}\`)
    process.exit(1)
  }

  switch (shell) {
    case "bash":
      console.log(BASH_COMPLETION)
      break
    case "zsh":
      console.log("# zsh completion not yet implemented")
      break
    case "fish":
      console.log("# fish completion not yet implemented")
      break
  }
}
```

**Step 2: Register the command in cli.ts**

Add before `program.parse()` in `src/cli.ts`:

```typescript
// Completion command
program
  .command("completion <shell>")
  .description("Output shell completion script (bash, zsh, fish)")
  .action(async (shell) => {
    const { completionCommand } = await import("./commands/completion.ts")
    completionCommand(shell)
  })
```

**Step 3: Test manually**

Run: `bun run src/cli.ts completion bash`
Expected: Outputs bash completion script

Run: `bun run src/cli.ts completion invalid`
Expected: Error message and exit code 1

**Step 4: Commit**

```bash
git add src/commands/completion.ts src/cli.ts
git commit -m "feat: add completion command with bash support"
```

---

## Task 2: Add zsh completion support

**Files:**
- Modify: `src/commands/completion.ts`

**Step 1: Add zsh completion script**

Add the ZSH_COMPLETION constant after BASH_COMPLETION in `src/commands/completion.ts`:

```typescript
const ZSH_COMPLETION = `
#compdef siteio

_siteio() {
    local -a commands sites_cmds apps_cmds groups_cmds agent_cmds skill_cmds

    commands=(
        'status:Show connection status'
        'login:Configure API credentials'
        'sites:Manage deployed sites'
        'apps:Manage containerized applications'
        'groups:Manage email groups for access control'
        'agent:Run the siteio agent server'
        'update:Update siteio to the latest version'
        'skill:Manage Claude Code skill integration'
        'completion:Output shell completion script'
    )

    sites_cmds=(
        'deploy:Deploy a folder as a static site'
        'list:List all deployed sites'
        'ls:List all deployed sites'
        'info:Show detailed info about a site'
        'download:Download a deployed site to a local folder'
        'rm:Remove a deployed site'
        'auth:Set or remove Google OAuth for a site'
    )

    apps_cmds=(
        'create:Create a new app'
        'list:List all apps'
        'ls:List all apps'
        'info:Show detailed info about an app'
        'deploy:Deploy (start) an app container'
        'stop:Stop an app container'
        'restart:Restart an app container'
        'rm:Remove an app'
        'logs:View app container logs'
        'set:Update app configuration'
    )

    groups_cmds=(
        'list:List all groups'
        'ls:List all groups'
        'show:Show group details'
        'create:Create a new group'
        'delete:Delete a group'
        'add:Add emails to a group'
        'remove:Remove emails from a group'
    )

    agent_cmds=(
        'install:Install and start the agent as a systemd service'
        'oauth:Configure OIDC authentication'
        'start:Start the agent server'
        'stop:Stop the agent server'
        'restart:Restart the agent server'
        'status:Check agent server status'
    )

    skill_cmds=(
        'install:Install the siteio skill for Claude Code'
        'uninstall:Remove the siteio skill from Claude Code'
    )

    if (( CURRENT == 2 )); then
        _describe -t commands 'siteio commands' commands
    elif (( CURRENT == 3 )); then
        case "\$words[2]" in
            sites) _describe -t sites_cmds 'sites commands' sites_cmds ;;
            apps) _describe -t apps_cmds 'apps commands' apps_cmds ;;
            groups) _describe -t groups_cmds 'groups commands' groups_cmds ;;
            agent) _describe -t agent_cmds 'agent commands' agent_cmds ;;
            skill) _describe -t skill_cmds 'skill commands' skill_cmds ;;
            completion) _values 'shell' bash zsh fish ;;
        esac
    fi
}

_siteio "\$@"
`.trim()
```

**Step 2: Update the switch statement**

Replace the zsh case:

```typescript
    case "zsh":
      console.log(ZSH_COMPLETION)
      break
```

**Step 3: Test manually**

Run: `bun run src/cli.ts completion zsh`
Expected: Outputs zsh completion script with command descriptions

**Step 4: Commit**

```bash
git add src/commands/completion.ts
git commit -m "feat: add zsh completion support"
```

---

## Task 3: Add fish completion support

**Files:**
- Modify: `src/commands/completion.ts`

**Step 1: Add fish completion script**

Add the FISH_COMPLETION constant after ZSH_COMPLETION:

```typescript
const FISH_COMPLETION = `
# siteio fish completion

# Disable file completion by default
complete -c siteio -f

# Main commands
complete -c siteio -n "__fish_use_subcommand" -a status -d "Show connection status"
complete -c siteio -n "__fish_use_subcommand" -a login -d "Configure API credentials"
complete -c siteio -n "__fish_use_subcommand" -a sites -d "Manage deployed sites"
complete -c siteio -n "__fish_use_subcommand" -a apps -d "Manage containerized applications"
complete -c siteio -n "__fish_use_subcommand" -a groups -d "Manage email groups for access control"
complete -c siteio -n "__fish_use_subcommand" -a agent -d "Run the siteio agent server"
complete -c siteio -n "__fish_use_subcommand" -a update -d "Update siteio to the latest version"
complete -c siteio -n "__fish_use_subcommand" -a skill -d "Manage Claude Code skill integration"
complete -c siteio -n "__fish_use_subcommand" -a completion -d "Output shell completion script"

# Sites subcommands
complete -c siteio -n "__fish_seen_subcommand_from sites" -a deploy -d "Deploy a folder as a static site"
complete -c siteio -n "__fish_seen_subcommand_from sites" -a list -d "List all deployed sites"
complete -c siteio -n "__fish_seen_subcommand_from sites" -a ls -d "List all deployed sites"
complete -c siteio -n "__fish_seen_subcommand_from sites" -a info -d "Show detailed info about a site"
complete -c siteio -n "__fish_seen_subcommand_from sites" -a download -d "Download a deployed site to a local folder"
complete -c siteio -n "__fish_seen_subcommand_from sites" -a rm -d "Remove a deployed site"
complete -c siteio -n "__fish_seen_subcommand_from sites" -a auth -d "Set or remove Google OAuth for a site"

# Apps subcommands
complete -c siteio -n "__fish_seen_subcommand_from apps" -a create -d "Create a new app"
complete -c siteio -n "__fish_seen_subcommand_from apps" -a list -d "List all apps"
complete -c siteio -n "__fish_seen_subcommand_from apps" -a ls -d "List all apps"
complete -c siteio -n "__fish_seen_subcommand_from apps" -a info -d "Show detailed info about an app"
complete -c siteio -n "__fish_seen_subcommand_from apps" -a deploy -d "Deploy (start) an app container"
complete -c siteio -n "__fish_seen_subcommand_from apps" -a stop -d "Stop an app container"
complete -c siteio -n "__fish_seen_subcommand_from apps" -a restart -d "Restart an app container"
complete -c siteio -n "__fish_seen_subcommand_from apps" -a rm -d "Remove an app"
complete -c siteio -n "__fish_seen_subcommand_from apps" -a logs -d "View app container logs"
complete -c siteio -n "__fish_seen_subcommand_from apps" -a set -d "Update app configuration"

# Groups subcommands
complete -c siteio -n "__fish_seen_subcommand_from groups" -a list -d "List all groups"
complete -c siteio -n "__fish_seen_subcommand_from groups" -a ls -d "List all groups"
complete -c siteio -n "__fish_seen_subcommand_from groups" -a show -d "Show group details"
complete -c siteio -n "__fish_seen_subcommand_from groups" -a create -d "Create a new group"
complete -c siteio -n "__fish_seen_subcommand_from groups" -a delete -d "Delete a group"
complete -c siteio -n "__fish_seen_subcommand_from groups" -a add -d "Add emails to a group"
complete -c siteio -n "__fish_seen_subcommand_from groups" -a remove -d "Remove emails from a group"

# Agent subcommands
complete -c siteio -n "__fish_seen_subcommand_from agent" -a install -d "Install and start the agent as a systemd service"
complete -c siteio -n "__fish_seen_subcommand_from agent" -a oauth -d "Configure OIDC authentication"
complete -c siteio -n "__fish_seen_subcommand_from agent" -a start -d "Start the agent server"
complete -c siteio -n "__fish_seen_subcommand_from agent" -a stop -d "Stop the agent server"
complete -c siteio -n "__fish_seen_subcommand_from agent" -a restart -d "Restart the agent server"
complete -c siteio -n "__fish_seen_subcommand_from agent" -a status -d "Check agent server status"

# Skill subcommands
complete -c siteio -n "__fish_seen_subcommand_from skill" -a install -d "Install the siteio skill for Claude Code"
complete -c siteio -n "__fish_seen_subcommand_from skill" -a uninstall -d "Remove the siteio skill from Claude Code"

# Completion subcommands
complete -c siteio -n "__fish_seen_subcommand_from completion" -a "bash zsh fish" -d "Shell type"
`.trim()
```

**Step 2: Update the switch statement**

Replace the fish case:

```typescript
    case "fish":
      console.log(FISH_COMPLETION)
      break
```

**Step 3: Test manually**

Run: `bun run src/cli.ts completion fish`
Expected: Outputs fish completion script

**Step 4: Commit**

```bash
git add src/commands/completion.ts
git commit -m "feat: add fish completion support"
```

---

## Task 4: Add CLI tests for completion command

**Files:**
- Modify: `src/__tests__/cli/commands.test.ts`

**Step 1: Add completion command tests**

Add these tests at the end of the describe block in `src/__tests__/cli/commands.test.ts`:

```typescript
  test("should output bash completion script", async () => {
    const result = await runCli(["completion", "bash"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("_siteio")
    expect(result.stdout).toContain("complete -F _siteio siteio")
  })

  test("should output zsh completion script", async () => {
    const result = await runCli(["completion", "zsh"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("#compdef siteio")
    expect(result.stdout).toContain("_siteio")
  })

  test("should output fish completion script", async () => {
    const result = await runCli(["completion", "fish"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("complete -c siteio")
  })

  test("should reject invalid shell for completion", async () => {
    const result = await runCli(["completion", "powershell"])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Invalid shell")
  })
```

**Step 2: Run tests**

Run: `bun test src/__tests__/cli/commands.test.ts`
Expected: All tests pass

**Step 3: Commit**

```bash
git add src/__tests__/cli/commands.test.ts
git commit -m "test: add completion command tests"
```

---

## Task 5: Update installer to auto-install completions

**Files:**
- Modify: `site/install`

**Step 1: Add NO_COMPLETIONS variable and install_completions function**

After the `NO_MODIFY_PATH` variable declaration (around line 10), add:

```sh
NO_COMPLETIONS="${SITEIO_NO_COMPLETIONS:-}"
```

After the `add_to_path` function, add:

```sh
install_completions() {
    local install_dir="$1"
    local siteio="$install_dir/siteio"

    # Skip if completions already installed (check for siteio completion marker)
    case "$SHELL" in
        */zsh)
            if grep -q "# siteio completion" "$HOME/.zshrc" 2>/dev/null || \
               grep -q "#compdef siteio" "$HOME/.zshrc" 2>/dev/null; then
                return 0
            fi
            {
                printf '\n# siteio completion\n'
                "$siteio" completion zsh
            } >> "$HOME/.zshrc"
            info "Added zsh completions to ~/.zshrc"
            ;;
        */bash)
            local bashrc="$HOME/.bashrc"
            if [ -f "$HOME/.bash_profile" ]; then
                bashrc="$HOME/.bash_profile"
            fi
            if grep -q "# siteio" "$bashrc" 2>/dev/null; then
                return 0
            fi
            {
                printf '\n# siteio completion\n'
                "$siteio" completion bash
            } >> "$bashrc"
            info "Added bash completions to $bashrc"
            ;;
        */fish)
            local fish_comp="$HOME/.config/fish/completions/siteio.fish"
            if [ -f "$fish_comp" ]; then
                return 0
            fi
            mkdir -p "$HOME/.config/fish/completions"
            "$siteio" completion fish > "$fish_comp"
            info "Added fish completions"
            ;;
    esac
}
```

**Step 2: Update the help text**

In the `--help` section, add the new option:

```sh
  --no-completions       Don't install shell completions
```

And add to environment variables section:

```sh
  SITEIO_NO_COMPLETIONS   Set to skip completion installation
```

**Step 3: Add argument parsing for --no-completions**

In the argument parsing loop, add:

```sh
            --no-completions)
                NO_COMPLETIONS=1
                shift
                ;;
```

**Step 4: Call install_completions in main**

After the `add_to_path` call, add:

```sh
    # Install shell completions if not disabled
    if [ -z "$NO_COMPLETIONS" ]; then
        install_completions "$install_dir"
    fi
```

**Step 5: Test manually**

Run: `./site/install --help`
Expected: Shows --no-completions option

**Step 6: Commit**

```bash
git add site/install
git commit -m "feat: auto-install shell completions in installer"
```

---

## Task 6: Update issue and verify

**Step 1: Run full test suite**

Run: `bun test`
Expected: All tests pass

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

**Step 3: Test completions manually in zsh**

```bash
source <(bun run src/cli.ts completion zsh)
siteio <TAB>
siteio sites <TAB>
```

Expected: Tab completion shows available commands

**Step 4: Close the issue**

```bash
bd close siteio-88n
bd sync
```

**Step 5: Final commit if needed**

```bash
git status
git push
```
