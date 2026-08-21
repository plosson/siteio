import { existsSync, mkdirSync, rmSync, readdirSync } from "fs"
import { join } from "path"
import { randomBytes } from "node:crypto"
import type { ChatConfig, ChatEvent, ChatMessage, ChatToolCall, SiteInfo } from "../../../types.ts"
import type { SiteStorage } from "../storage.ts"
import type { ChatStore } from "../chat-store.ts"
import type { ChatExecutor } from "./executor.ts"
import { LocalChatExecutor } from "./local-executor.ts"
import { SandboxChatExecutor } from "./sandbox-executor.ts"
import { ClaudeRunner } from "./claude-runner.ts"
import { prepareWorkspace, buildDeployZip, hasWebChanges } from "./workspace.ts"

// A turn couldn't start because another is already running for this site.
export class ChatBusyError extends Error {
  constructor(site: string) {
    super(`A chat turn is already in progress for '${site}'.`)
    this.name = "ChatBusyError"
  }
}

// A turn couldn't start because the site or config is unusable (caller → 4xx).
export class ChatUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ChatUnavailableError"
  }
}

export interface ChatControllerDeps {
  chat: ChatConfig
  sites: SiteStorage
  chats: ChatStore
  dataDir: string
  domain: string
  // Deploy a merged zip and return the new SiteInfo. Provided by the server so
  // the controller reuses the shared deploy core + status bookkeeping.
  deploy: (siteName: string, zipData: Uint8Array, deployedBy: string, message: string) => Promise<SiteInfo>
  // Test seam: inject a fake executor to drive the controller without a real
  // agent/container. Production leaves this unset and the sandbox/local executor
  // is chosen from config.
  executor?: ChatExecutor
}

const HISTORY_CONTEXT_TURNS = 8

export class ChatController {
  private active = new Set<string>()
  // Per-site abort handle for the in-flight turn, so a Stop request can cancel
  // it. The turn is deliberately NOT tied to the client's SSE connection —
  // navigating away lets it finish server-side (history poll resurfaces it).
  private aborters = new Map<string, AbortController>()
  private executor: ChatExecutor
  private sandbox: SandboxChatExecutor | null

  constructor(private deps: ChatControllerDeps) {
    if (deps.executor) {
      this.sandbox = null
      this.executor = deps.executor
    } else if (deps.chat.sandbox) {
      this.sandbox = new SandboxChatExecutor({ image: deps.chat.sandboxImage, network: deps.chat.sandboxNetwork })
      this.executor = this.sandbox
    } else {
      this.sandbox = null
      this.executor = new LocalChatExecutor()
    }
  }

  isActive(site: string): boolean {
    return this.active.has(site)
  }

  // Abort the in-flight turn for a site. Returns whether one was running.
  stop(site: string): boolean {
    const ac = this.aborters.get(site)
    if (!ac) return false
    ac.abort()
    return true
  }

  private workspaceRoot(): string {
    return join(this.deps.dataDir, "chat-workspaces")
  }

  // Remove workspaces left behind by a crash/OOM (finally-cleanup can be skipped).
  // Safe to call at startup: never runs concurrently with a live turn.
  sweepWorkspaces(): void {
    const root = this.workspaceRoot()
    if (!existsSync(root)) return
    try {
      for (const entry of readdirSync(root)) {
        rmSync(join(root, entry), { recursive: true, force: true })
      }
    } catch {
      /* best effort */
    }
  }

  // Run one chat turn end-to-end. Persists the user message immediately, streams
  // agent activity via onEvent, deploys any change, then persists + returns the
  // assistant message. Throws ChatBusyError / ChatUnavailableError before any
  // state change if the turn can't start.
  async runTurn(input: {
    siteName: string
    userMessage: string
    onEvent: (e: ChatEvent) => void
  }): Promise<ChatMessage> {
    const { siteName, userMessage, onEvent } = input
    const text = userMessage.trim()
    if (!text) throw new ChatUnavailableError("Message cannot be empty.")

    const site = this.deps.sites.get(siteName)
    if (!site) throw new ChatUnavailableError("Site not found.")
    if (site.version === undefined) {
      throw new ChatUnavailableError("Deploy the site once before using chat.")
    }
    if (this.sandbox && !this.sandbox.imageAvailable()) {
      throw new ChatUnavailableError(
        `Chat sandbox image '${this.deps.chat.sandboxImage}' is not built. Run: docker build -t ${this.deps.chat.sandboxImage} docker/chat-sandbox`
      )
    }

    if (this.active.has(siteName)) throw new ChatBusyError(siteName)
    this.active.add(siteName)
    const aborter = new AbortController()
    this.aborters.set(siteName, aborter)
    const signal = aborter.signal

    // Persist the user message up front so a reloaded tab (history poll) sees it
    // even while the turn is still running.
    const userMsg: ChatMessage = {
      id: randomBytes(8).toString("hex"),
      role: "user",
      text,
      at: new Date().toISOString(),
    }
    this.deps.chats.append(siteName, userMsg)

    const turnId = randomBytes(8).toString("hex")
    const workspaceDir = join(this.workspaceRoot(), siteName, turnId)
    const versionBefore = site.version
    const toolCalls: ChatToolCall[] = []

    try {
      mkdirSync(join(this.workspaceRoot(), siteName), { recursive: true, mode: 0o700 })
      prepareWorkspace(this.deps.sites.getCodePath(siteName), workspaceDir)

      const runner = new ClaudeRunner({ oauthToken: this.deps.chat.oauthToken, apiKey: this.deps.chat.apiKey })
      const systemPrompt = this.buildSystemPrompt(siteName)

      // Accumulate tool-call chips for the persisted transcript as we stream.
      const collectingOnEvent = (e: ChatEvent): void => {
        if (e.kind === "tool_call") toolCalls.push({ name: e.name, detail: e.detail })
        onEvent(e)
      }

      const result = await this.executor.run({
        runner,
        spec: {
          userMessage: text,
          systemPrompt,
          maxTurns: this.deps.chat.maxTurns,
          model: this.deps.chat.model,
        },
        workspaceDir,
        onEvent: collectingOnEvent,
        signal,
        timeoutMs: this.deps.chat.timeoutMs,
      })

      // Terminal failure modes that skip deploy.
      if (result.aborted) return this.finishError(siteName, "Turn cancelled.", versionBefore, toolCalls)
      if (result.timedOut) {
        return this.finishError(siteName, "Turn timed out.", versionBefore, toolCalls)
      }
      if (result.isError) {
        return this.finishError(
          siteName,
          result.finalText || "The agent encountered an error.",
          versionBefore,
          toolCalls
        )
      }

      // No-op turn (a question, or edits that changed nothing): don't deploy.
      const { changed, changedFiles } = hasWebChanges(workspaceDir, this.deps.sites.getCodePath(siteName))
      if (!changed) {
        return this.finish(siteName, {
          text: result.finalText || "No changes were needed.",
          status: "no_changes",
          toolCalls,
          versionBefore,
          deployed: false,
        })
      }

      // Deploy the change.
      onEvent({ kind: "deploy_progress", message: "Deploying changes…" })
      try {
        const zip = buildDeployZip(workspaceDir, this.deps.sites.getCodePath(siteName))
        const info = await this.deps.deploy(siteName, zip, "AI chat", firstLine(text))
        onEvent({ kind: "deploy_progress", message: `Deployed v${info.version}` })
        return this.finish(siteName, {
          text: result.finalText || "Done.",
          status: "ok",
          toolCalls,
          changedFiles,
          versionBefore,
          versionAfter: info.version,
          deployed: true,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : "Deploy failed"
        return this.finishError(siteName, `Changes were made but the deploy failed: ${message}`, versionBefore, toolCalls, changedFiles)
      }
    } finally {
      this.active.delete(siteName)
      this.aborters.delete(siteName)
      try {
        rmSync(workspaceDir, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
  }

  private buildSystemPrompt(siteName: string): string {
    const url = `https://${siteName}.${this.deps.domain}`
    const history = this.deps.chats
      .list(siteName)
      .slice(-HISTORY_CONTEXT_TURNS)
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${firstLine(m.text)}`)
      .join("\n")

    return [
      `You are an AI web developer editing the live static website "${siteName}" hosted on siteio.`,
      `Your current working directory contains the site's web files exactly as visitors see them — edit these files directly (index.html, css, js, assets).`,
      `Only edit files inside this directory. Do not attempt to read or write anything outside it.`,
      `When you finish, your changes are deployed to the live site automatically, so make complete, working edits.`,
      `Keep changes focused on what the user asked. Live site: ${url}`,
      history ? `\nRecent conversation:\n${history}` : "",
    ]
      .filter(Boolean)
      .join("\n")
  }

  private finish(
    siteName: string,
    m: {
      text: string
      status: ChatMessage["status"]
      toolCalls: ChatToolCall[]
      changedFiles?: string[]
      versionBefore?: number
      versionAfter?: number
      deployed: boolean
    }
  ): ChatMessage {
    const msg: ChatMessage = {
      id: randomBytes(8).toString("hex"),
      role: "assistant",
      text: m.text,
      at: new Date().toISOString(),
      status: m.status,
      toolCalls: m.toolCalls.length ? m.toolCalls : undefined,
      changedFiles: m.changedFiles?.length ? m.changedFiles : undefined,
      versionBefore: m.versionBefore,
      versionAfter: m.versionAfter,
      deployed: m.deployed,
    }
    this.deps.chats.append(siteName, msg)
    return msg
  }

  private finishError(
    siteName: string,
    error: string,
    versionBefore: number | undefined,
    toolCalls: ChatToolCall[],
    changedFiles?: string[]
  ): ChatMessage {
    return this.finish(siteName, {
      text: error,
      status: "error",
      toolCalls,
      changedFiles,
      versionBefore,
      deployed: false,
    })
  }
}

function firstLine(s: string): string {
  const line = s.split("\n")[0]!.trim()
  return line.length > 200 ? line.slice(0, 199) + "…" : line
}
