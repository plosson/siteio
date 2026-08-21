import type { ChatEvent } from "../../../types.ts"

// One agent turn's inputs. `systemPrompt` carries site context + recent history;
// `userMessage` is the new user request. cwd is decided by the executor.
export interface AgentTurnSpec {
  userMessage: string
  systemPrompt: string
  maxTurns: number
  model?: string
}

// Result of parsing one line of the agent process's stdout.
export interface ParsedLine {
  events: ChatEvent[]
  // Present only on the terminal line, carrying the final assistant text.
  result?: { text: string; isError: boolean }
}

// Provider seam (plan §3 Seam B). An AgentRunner knows how to invoke a coding
// agent for one turn and how to parse its streaming output — but NOT where it
// runs. The ChatExecutor (Seam A) owns the process/container. This keeps the
// isolation and provider choices independent, so a non-Claude runner or a
// different sandbox can drop in without touching the other seam.
export interface AgentRunner {
  // argv to execute with cwd = the workspace root, for one turn.
  buildArgv(spec: AgentTurnSpec): string[]
  // Env the invocation needs (the LLM credential). Kept separate so the sandbox
  // executor controls whether/how the credential enters the container.
  buildEnv(): Record<string, string>
  // Parse one raw stdout line into zero or more ChatEvents (+ terminal result).
  parseLine(line: string): ParsedLine
}
