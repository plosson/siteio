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
    console.error(`Invalid shell: ${shell}. Must be one of: ${validShells.join(", ")}`)
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
