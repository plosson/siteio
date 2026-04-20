import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { AgentServer } from "../../../src/lib/agent/server"
import type { AgentConfig } from "../../../src/types"

export interface TestServerHandle {
  url: string
  apiKey: string
  dataDir: string
  server: AgentServer
  cleanup: () => void
}

let nextPort = 4600

export async function startTestServer(opts: { apiKey?: string } = {}): Promise<TestServerHandle> {
  const apiKey = opts.apiKey ?? "test-api-key"
  const dataDir = mkdtempSync(join(tmpdir(), "siteio-ui-e2e-"))
  const port = nextPort++

  const config: AgentConfig = {
    domain: "test.example.com",
    apiKey,
    dataDir,
    port,
    skipTraefik: true,
    maxUploadSize: 50 * 1024 * 1024,
    httpPort: 80,
    httpsPort: 443,
  }

  const server = new AgentServer(config)
  await server.start()

  return {
    url: `http://127.0.0.1:${port}`,
    apiKey,
    dataDir,
    server,
    cleanup: () => {
      server.stop()
      try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
    },
  }
}
