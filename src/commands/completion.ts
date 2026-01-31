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
        case "\\$words[2]" in
            sites) _describe -t sites_cmds 'sites commands' sites_cmds ;;
            apps) _describe -t apps_cmds 'apps commands' apps_cmds ;;
            groups) _describe -t groups_cmds 'groups commands' groups_cmds ;;
            agent) _describe -t agent_cmds 'agent commands' agent_cmds ;;
            skill) _describe -t skill_cmds 'skill commands' skill_cmds ;;
            completion) _values 'shell' bash zsh fish ;;
        esac
    fi
}

_siteio "\\$@"
`.trim()

export function completionCommand(shell: string): void {
  const validShells = ["bash", "zsh", "fish"]

  if (!validShells.includes(shell)) {
    console.error(`Invalid shell: ${shell}. Must be one of: ${validShells.join(", ")}`)
    process.exit(1)
  }

  switch (shell) {
    case "bash":
      console.log(BASH_COMPLETION)
      break
    case "zsh":
      console.log(ZSH_COMPLETION)
      break
    case "fish":
      console.log("# fish completion not yet implemented")
      break
  }
}
