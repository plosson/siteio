# Shell Autocompletion Design

**Issue:** siteio-88n
**Date:** 2026-01-30
**Status:** Ready for implementation

## Summary

Add shell autocompletion for bash, zsh, and fish shells. Completions are static (commands, subcommands, options only - no dynamic API lookups).

## Command Interface

```
siteio completion <shell>
```

Where `<shell>` is one of: `bash`, `zsh`, `fish`

**Behavior:**
- Outputs the completion script to stdout
- Errors to stderr if invalid shell specified

**Usage:**
```bash
# Bash
siteio completion bash >> ~/.bashrc

# Zsh
siteio completion zsh >> ~/.zshrc

# Fish
siteio completion fish > ~/.config/fish/completions/siteio.fish
```

## Automatic Installation

The installer script (`site/install`) will automatically install completions after installing the binary. This mirrors the existing PATH modification behavior.

- Detects shell from `$SHELL`
- Calls `siteio completion <shell>` and writes to appropriate location
- Skipped with `--no-completions` flag

## Implementation

### New Dependency

```
tabtab
```

Library that generates shell completion scripts from Commander.js programs.

### New Files

**`src/commands/completion.ts`**
```typescript
import tabtab from 'tabtab'

export function completionCommand(shell: string) {
  const validShells = ['bash', 'zsh', 'fish']

  if (!validShells.includes(shell)) {
    console.error(`Invalid shell: ${shell}. Must be one of: ${validShells.join(', ')}`)
    process.exit(1)
  }

  const script = tabtab.getCompletionScript({
    name: 'siteio',
    completer: 'siteio',
    shell: shell
  })

  console.log(script)
}
```

### Modified Files

**`src/cli.ts`** - Register the completion command:
```typescript
program
  .command('completion <shell>')
  .description('Output shell completion script (bash, zsh, fish)')
  .action(async (shell) => {
    const { completionCommand } = await import('./commands/completion')
    completionCommand(shell)
  })
```

**`site/install`** - Add completion installation:
```sh
install_completions() {
    local install_dir="$1"
    local siteio="$install_dir/siteio"

    case "$SHELL" in
        */zsh)
            "$siteio" completion zsh >> "$HOME/.zshrc"
            info "Added zsh completions to ~/.zshrc"
            ;;
        */bash)
            if [ -f "$HOME/.bash_profile" ]; then
                "$siteio" completion bash >> "$HOME/.bash_profile"
                info "Added bash completions to ~/.bash_profile"
            else
                "$siteio" completion bash >> "$HOME/.bashrc"
                info "Added bash completions to ~/.bashrc"
            fi
            ;;
        */fish)
            mkdir -p "$HOME/.config/fish/completions"
            "$siteio" completion fish > "$HOME/.config/fish/completions/siteio.fish"
            info "Added fish completions"
            ;;
    esac
}
```

Called after `add_to_path`, skipped if `--no-completions` flag is passed.

## Testing

- Unit test: Verify `siteio completion bash/zsh/fish` outputs non-empty scripts
- Unit test: Verify invalid shell name produces error
- Manual test: Source completions in each shell, verify tab-completion works

## Notes

- The exact tabtab API will be verified during implementation
- No breaking changes - purely additive feature
- New installs get completions automatically
- Existing users run `siteio completion <shell> >> ~/.shellrc`
