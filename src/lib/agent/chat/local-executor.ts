import type { ChatExecutor, ExecutorRunInput, ExecutorResult } from "./executor.ts"
import { streamAgentProcess } from "./executor.ts"

// Runs the agent as a host process with cwd = the workspace. NO isolation: the
// agent has a full shell on the host. This is intended for local dev and
// trusted single-tenant instances only (SITEIO_CHAT_SANDBOX=false). On a shared
// host use SandboxChatExecutor. See plan §3 / §7 Blocker B.
export class LocalChatExecutor implements ChatExecutor {
  run(input: ExecutorRunInput): Promise<ExecutorResult> {
    const cmd = input.runner.buildArgv(input.spec)
    const env = { ...process.env, ...input.runner.buildEnv() }
    return streamAgentProcess({
      cmd,
      cwd: input.workspaceDir,
      env,
      runner: input.runner,
      onEvent: input.onEvent,
      signal: input.signal,
      timeoutMs: input.timeoutMs,
      makeKill: (proc) => () => {
        try {
          proc.kill()
        } catch {
          /* already gone */
        }
        // Escalate if it doesn't exit promptly.
        setTimeout(() => {
          try {
            proc.kill(9)
          } catch {
            /* ignore */
          }
        }, 2000)
      },
    })
  }
}
