import type { ChatEvent } from "../../../types.ts"
import type { AgentRunner, AgentTurnSpec, ParsedLine } from "./agent-runner.ts"

// AgentRunner backed by the Claude Code CLI in headless stream-json mode — the
// same interface the Claude Agent SDK drives under the hood, but invoked
// directly so it works identically whether the ChatExecutor runs it on the host
// or inside a container (the sandbox image ships the `claude` CLI).
//
// The credential is a Claude subscription OAuth token (CLAUDE_CODE_OAUTH_TOKEN,
// preferred) or an Anthropic API key (ANTHROPIC_API_KEY).
export class ClaudeRunner implements AgentRunner {
  constructor(
    private cred: { oauthToken?: string; apiKey?: string }
  ) {}

  buildArgv(spec: AgentTurnSpec): string[] {
    const argv = [
      "claude",
      "-p",
      spec.userMessage,
      "--output-format",
      "stream-json",
      "--verbose",
      // The whole point of the sandbox is that the agent may edit/run freely; no
      // interactive approval is possible in headless mode anyway.
      "--permission-mode",
      "bypassPermissions",
      "--max-turns",
      String(spec.maxTurns),
      "--append-system-prompt",
      spec.systemPrompt,
    ]
    if (spec.model) argv.push("--model", spec.model)
    return argv
  }

  buildEnv(): Record<string, string> {
    const env: Record<string, string> = {}
    if (this.cred.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = this.cred.oauthToken
    else if (this.cred.apiKey) env.ANTHROPIC_API_KEY = this.cred.apiKey
    return env
  }

  parseLine(line: string): ParsedLine {
    const trimmed = line.trim()
    if (!trimmed) return { events: [] }
    let obj: any
    try {
      obj = JSON.parse(trimmed)
    } catch {
      return { events: [] } // non-JSON noise (shouldn't happen in stream-json)
    }
    return parseStreamEvent(obj)
  }
}

// Pure translation of one stream-json object → ChatEvents (+ terminal result).
// Exported for unit testing. Defensive: unknown shapes yield no events.
export function parseStreamEvent(obj: any): ParsedLine {
  if (!obj || typeof obj !== "object") return { events: [] }

  switch (obj.type) {
    case "assistant": {
      const events: ChatEvent[] = []
      const content = obj.message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "text" && block.text) {
            events.push({ kind: "assistant_text", text: block.text })
          } else if (block?.type === "thinking" && block.thinking) {
            events.push({ kind: "thinking", text: block.thinking })
          } else if (block?.type === "tool_use" && block.name) {
            events.push({ kind: "tool_call", name: block.name, detail: summarizeToolInput(block.name, block.input) })
          }
        }
      }
      return { events }
    }
    case "user": {
      const events: ChatEvent[] = []
      const content = obj.message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "tool_result") {
            events.push({ kind: "tool_result", ok: !block.is_error })
          }
        }
      }
      return { events }
    }
    case "result": {
      const text = typeof obj.result === "string" ? obj.result : ""
      const isError = obj.is_error === true || obj.subtype !== "success"
      return { events: [], result: { text, isError } }
    }
    default:
      return { events: [] } // system/init and anything else: no UI event
  }
}

// A short human label for a tool call, shown as a chip in the transcript.
function summarizeToolInput(name: string, input: any): string | undefined {
  if (!input || typeof input !== "object") return undefined
  switch (name) {
    case "Edit":
    case "Write":
    case "Read":
    case "NotebookEdit":
      return typeof input.file_path === "string" ? input.file_path : undefined
    case "Bash":
      return typeof input.command === "string" ? truncate(input.command, 80) : undefined
    case "Glob":
    case "Grep":
      return typeof input.pattern === "string" ? truncate(input.pattern, 60) : undefined
    default: {
      const first = Object.values(input)[0]
      return typeof first === "string" ? truncate(first, 60) : undefined
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s
}
