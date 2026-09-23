// Prefix a command with sudo unless we already run as root. Minimal servers
// and containers where the agent runs as root often have no sudo at all, so
// an unconditional `sudo` fails there with "Executable not found".
export function asRoot(cmd: string[], uid: number | undefined = process.getuid?.()): string[] {
  return uid === 0 ? cmd : ["sudo", ...cmd]
}
