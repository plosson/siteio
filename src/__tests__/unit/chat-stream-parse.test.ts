import { describe, test, expect } from "bun:test"
import { parseStreamEvent, ClaudeRunner } from "../../lib/agent/chat/claude-runner.ts"

describe("Unit: claude stream-json parsing", () => {
  test("assistant text block → assistant_text", () => {
    const { events } = parseStreamEvent({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello there" }] },
    })
    expect(events).toEqual([{ kind: "assistant_text", text: "Hello there" }])
  })

  test("assistant tool_use → tool_call with summarized detail", () => {
    const { events } = parseStreamEvent({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "index.html" } }] },
    })
    expect(events).toEqual([{ kind: "tool_call", name: "Edit", detail: "index.html" }])
  })

  test("assistant thinking → thinking", () => {
    const { events } = parseStreamEvent({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "hmm" }] },
    })
    expect(events).toEqual([{ kind: "thinking", text: "hmm" }])
  })

  test("Bash tool_use summarizes the command", () => {
    const { events } = parseStreamEvent({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm run build" } }] },
    })
    expect(events[0]).toEqual({ kind: "tool_call", name: "Bash", detail: "npm run build" })
  })

  test("user tool_result → tool_result event with ok flag", () => {
    expect(parseStreamEvent({ type: "user", message: { content: [{ type: "tool_result", is_error: false }] } }).events)
      .toEqual([{ kind: "tool_result", ok: true }])
    expect(parseStreamEvent({ type: "user", message: { content: [{ type: "tool_result", is_error: true }] } }).events)
      .toEqual([{ kind: "tool_result", ok: false }])
  })

  test("result line → terminal result", () => {
    const parsed = parseStreamEvent({ type: "result", subtype: "success", result: "Done.", is_error: false })
    expect(parsed.events).toEqual([])
    expect(parsed.result).toEqual({ text: "Done.", isError: false })
  })

  test("error result is flagged", () => {
    const parsed = parseStreamEvent({ type: "result", subtype: "error_max_turns", result: "", is_error: true })
    expect(parsed.result?.isError).toBe(true)
  })

  test("system/init and unknown types produce nothing", () => {
    expect(parseStreamEvent({ type: "system", subtype: "init" }).events).toEqual([])
    expect(parseStreamEvent({ type: "whatever" }).events).toEqual([])
    expect(parseStreamEvent(null).events).toEqual([])
  })

  test("ClaudeRunner.parseLine ignores non-JSON noise", () => {
    const runner = new ClaudeRunner({ oauthToken: "x" })
    expect(runner.parseLine("not json").events).toEqual([])
    expect(runner.parseLine("").events).toEqual([])
  })

  test("ClaudeRunner builds argv and credential env", () => {
    const runner = new ClaudeRunner({ oauthToken: "tok" })
    const argv = runner.buildArgv({ userMessage: "hi", systemPrompt: "sys", maxTurns: 40 })
    expect(argv[0]).toBe("claude")
    expect(argv).toContain("stream-json")
    expect(argv).toContain("bypassPermissions")
    expect(argv[argv.indexOf("--max-turns") + 1]).toBe("40")
    expect(runner.buildEnv()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "tok" })

    const keyRunner = new ClaudeRunner({ apiKey: "sk-test" })
    expect(keyRunner.buildEnv()).toEqual({ ANTHROPIC_API_KEY: "sk-test" })
  })
})
