/**
 * SSH utility functions for remote command execution
 */

import { spawnSync, spawn } from "bun"

/**
 * Check if target looks like a remote SSH target (user@host)
 */
export function isRemoteTarget(target: string): boolean {
  return target.includes("@")
}

/**
 * Execute a command over SSH and capture output
 */
export async function sshExec(
  target: string,
  command: string,
  identity?: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const sshArgs = ["-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes"]
  if (identity) {
    sshArgs.push("-i", identity)
  }
  sshArgs.push(target, command)

  const result = spawnSync({
    cmd: ["ssh", ...sshArgs],
    stdout: "pipe",
    stderr: "pipe",
  })

  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

/**
 * Execute a command over SSH with streamed output (for interactive commands)
 */
export async function sshExecStream(
  target: string,
  command: string,
  identity?: string
): Promise<number> {
  const sshArgs = ["-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes", "-t", "-t"]
  if (identity) {
    sshArgs.push("-i", identity)
  }
  sshArgs.push(target, command)

  return new Promise((resolve) => {
    const proc = spawn({
      cmd: ["ssh", ...sshArgs],
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    })

    proc.exited.then((code) => resolve(code ?? 1))
  })
}
