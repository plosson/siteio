import { spawnSync } from "bun"
import { randomBytes } from "node:crypto"
import type { ChatExecutor, ExecutorRunInput, ExecutorResult } from "./executor.ts"
import { streamAgentProcess } from "./executor.ts"

// Runs the agent inside a throwaway container per turn — the v1 default and the
// security boundary on multi-tenant hosts (plan §8). Only the workspace is
// mounted; no /data, no docker socket, no host paths. Capabilities are dropped,
// resources capped, and the container is `docker kill`ed on timeout/abort so no
// grandchild process survives.
//
// Credential handling: the LLM token is passed via the docker process
// environment and forwarded with `-e NAME` (name only, no value), so it never
// appears in the container's argv / host process list. It IS present inside the
// container env — the known v1 gap the egress proxy (plan §8) later closes;
// egress must therefore be locked to the LLM host at the network layer.
export class SandboxChatExecutor implements ChatExecutor {
  constructor(private opts: { image: string; network: string }) {}

  run(input: ExecutorRunInput): Promise<ExecutorResult> {
    this.ensureNetwork()

    const containerName = `siteio-chat-${randomBytes(6).toString("hex")}`
    const agentArgv = input.runner.buildArgv(input.spec)
    const credEnv = input.runner.buildEnv()

    const dockerArgs = [
      "docker",
      "run",
      "--rm",
      "-i",
      "--name",
      containerName,
      "--network",
      this.opts.network,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "512",
      "--cpus",
      "2",
      "--memory",
      "2g",
      "-v",
      `${input.workspaceDir}:/work`,
      "-w",
      "/work",
      // Forward the credential + sandbox marker by NAME only (values come from
      // the docker process env below), keeping them out of argv/ps.
      ...Object.keys(credEnv).flatMap((k) => ["-e", k]),
      "-e",
      "IS_SANDBOX",
      this.opts.image,
      ...agentArgv,
    ]

    const env = { ...process.env, ...credEnv, IS_SANDBOX: "1" }

    return streamAgentProcess({
      cmd: dockerArgs,
      env,
      runner: input.runner,
      onEvent: input.onEvent,
      signal: input.signal,
      timeoutMs: input.timeoutMs,
      // Killing the `docker run` client does not stop the container; kill the
      // container by name so all in-container processes die with it.
      makeKill: (proc) => () => {
        try {
          spawnSync({ cmd: ["docker", "kill", containerName], stdout: "ignore", stderr: "ignore" })
        } catch {
          /* best effort */
        }
        try {
          proc.kill()
        } catch {
          /* ignore */
        }
      },
    })
  }

  // The sandbox joins its own network so operators can firewall its egress to
  // the LLM host only. Create it if missing (internal by default is NOT set here
  // because the agent must reach the LLM API; egress restriction is an operator
  // concern documented in the plan).
  private ensureNetwork(): void {
    const inspect = spawnSync({
      cmd: ["docker", "network", "inspect", this.opts.network],
      stdout: "ignore",
      stderr: "ignore",
    })
    if (inspect.exitCode !== 0) {
      spawnSync({
        cmd: ["docker", "network", "create", this.opts.network],
        stdout: "ignore",
        stderr: "ignore",
      })
    }
  }

  // Whether the sandbox image is present locally. The controller uses this to
  // fail a turn with a clear "build the image" message instead of a raw docker
  // error.
  imageAvailable(): boolean {
    const res = spawnSync({
      cmd: ["docker", "image", "inspect", this.opts.image],
      stdout: "ignore",
      stderr: "ignore",
    })
    return res.exitCode === 0
  }
}
