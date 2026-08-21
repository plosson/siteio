import type { ChatEvent } from "../../../types.ts"
import type { AgentRunner, AgentTurnSpec } from "./agent-runner.ts"

// Isolation seam (plan §3 Seam A). A ChatExecutor owns WHERE the agent runs and
// how its process is torn down — the host (LocalChatExecutor) or a throwaway
// container (SandboxChatExecutor) — but not which agent/provider runs. It drives
// an AgentRunner in its chosen environment and streams the runner's parsed
// events out via onEvent.
export interface ExecutorRunInput {
  runner: AgentRunner
  spec: AgentTurnSpec
  workspaceDir: string
  onEvent: (e: ChatEvent) => void
  signal: AbortSignal
  timeoutMs: number
}

export interface ExecutorResult {
  finalText: string
  isError: boolean
  aborted: boolean
  timedOut: boolean
}

export interface ChatExecutor {
  run(input: ExecutorRunInput): Promise<ExecutorResult>
}

// Shared streaming core: spawn a subprocess, split stdout into lines, parse each
// through the runner, forward events, capture the terminal result, and enforce
// abort + wall-clock timeout via an executor-supplied kill(). Used by both
// executors so the line protocol lives in exactly one place.
export async function streamAgentProcess(opts: {
  cmd: string[]
  cwd?: string
  env: Record<string, string | undefined>
  runner: AgentRunner
  onEvent: (e: ChatEvent) => void
  signal: AbortSignal
  timeoutMs: number
  // Environment-specific teardown (proc.kill for host; `docker kill` for sandbox).
  makeKill: (proc: ReturnType<typeof Bun.spawn>) => () => void
}): Promise<ExecutorResult> {
  const { cmd, cwd, env, runner, onEvent, signal, timeoutMs, makeKill } = opts

  const proc = Bun.spawn({
    cmd,
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })

  const kill = makeKill(proc)
  let aborted = false
  let timedOut = false
  let result: { text: string; isError: boolean } | undefined

  const onAbort = () => {
    aborted = true
    kill()
  }
  signal.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    kill()
  }, timeoutMs)

  const handleLine = (line: string): void => {
    const parsed = runner.parseLine(line)
    for (const ev of parsed.events) onEvent(ev)
    if (parsed.result) result = parsed.result
  }

  try {
    const decoder = new TextDecoder()
    let buf = ""
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true })
      let idx: number
      while ((idx = buf.indexOf("\n")) >= 0) {
        handleLine(buf.slice(0, idx))
        buf = buf.slice(idx + 1)
      }
    }
    if (buf.trim()) handleLine(buf)
    await proc.exited
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", onAbort)
  }

  if (aborted || timedOut) {
    return { finalText: "", isError: true, aborted, timedOut }
  }
  if (!result) {
    // Process ended without a terminal result line — capture stderr for context.
    let stderr = ""
    try {
      stderr = await new Response(proc.stderr as unknown as ReadableStream).text()
    } catch {
      /* ignore */
    }
    return {
      finalText: stderr.trim().slice(-500) || "The agent exited without producing a result.",
      isError: true,
      aborted: false,
      timedOut: false,
    }
  }
  return { finalText: result.text, isError: result.isError, aborted: false, timedOut: false }
}

// Re-exported for executors' spec construction convenience.
export type { AgentRunner, AgentTurnSpec }
