import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { AgentServer } from "../../lib/agent/server"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import type { ApiResponse, App, AgentConfig } from "../../types"

describe("Apps API - Inline Dockerfile Source", () => {
  let server: AgentServer
  let tempDir: string
  let baseUrl: string
  const apiKey = "dockerfile-apps-test-key"
  const testPort = 4571

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "siteio-dockerfile-apps-test-"))

    const config: AgentConfig = {
      apiKey,
      dataDir: tempDir,
      domain: "dockerfile-test.local",
      maxUploadSize: 10 * 1024 * 1024,
      httpPort: 80,
      httpsPort: 443,
      port: testPort,
      skipTraefik: true,
    }

    server = new AgentServer(config)
    await server.start()
    baseUrl = `http://localhost:${testPort}`
  })

  afterAll(async () => {
    server.stop()
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  async function request<T>(method: string, path: string, body?: object): Promise<ApiResponse<T>> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "X-API-Key": apiKey,
        ...(body && { "Content-Type": "application/json" }),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    return response.json() as Promise<ApiResponse<T>>
  }

  const sampleDockerfile = "FROM nginx:alpine\nRUN echo hello\n"

  describe("POST /apps - create with inline dockerfile", () => {
    test("creates app with dockerfile source and stores Dockerfile on disk", async () => {
      const result = await request<App>("POST", "/apps", {
        name: "df-app",
        dockerfileContent: sampleDockerfile,
        internalPort: 3000,
      })

      expect(result.success).toBe(true)
      expect(result.data?.name).toBe("df-app")
      expect(result.data?.dockerfile?.source).toBe("inline")
      // Locally-built apps reuse the siteio-{name}:latest tag convention
      expect(result.data?.image).toBe("siteio-df-app:latest")
      expect(result.data?.git).toBeUndefined()

      // Verify file was persisted in the data dir
      const stored = join(tempDir, "dockerfiles", "df-app", "Dockerfile")
      expect(existsSync(stored)).toBe(true)
      expect(readFileSync(stored, "utf-8")).toBe(sampleDockerfile)
    })

    test("rejects when both image and dockerfile are provided", async () => {
      const result = await request<App>("POST", "/apps", {
        name: "df-conflict-image",
        image: "nginx:alpine",
        dockerfileContent: sampleDockerfile,
        internalPort: 80,
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain("Specify only one")
    })

    test("rejects when both git and dockerfile are provided", async () => {
      const result = await request<App>("POST", "/apps", {
        name: "df-conflict-git",
        git: { repoUrl: "https://github.com/user/repo" },
        dockerfileContent: sampleDockerfile,
        internalPort: 80,
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain("Specify only one")
    })

    test("dockerfile source is included in app info on get", async () => {
      const result = await request<App>("GET", "/apps/df-app")
      expect(result.success).toBe(true)
      expect(result.data?.dockerfile?.source).toBe("inline")
    })

    test("dockerfile source is included in list response", async () => {
      const result = await request<App[]>("GET", "/apps")
      expect(result.success).toBe(true)
      const found = result.data?.find((a) => a.name === "df-app")
      expect(found?.dockerfile?.source).toBe("inline")
    })
  })

  describe("DELETE /apps/:name - cleanup", () => {
    test("deletes stored Dockerfile when app is removed", async () => {
      // Create a dedicated app for this test
      await request<App>("POST", "/apps", {
        name: "df-delete-me",
        dockerfileContent: sampleDockerfile,
        internalPort: 80,
      })

      const stored = join(tempDir, "dockerfiles", "df-delete-me", "Dockerfile")
      expect(existsSync(stored)).toBe(true)

      const result = await request<null>("DELETE", "/apps/df-delete-me")
      expect(result.success).toBe(true)

      // File and its directory should be gone
      expect(existsSync(stored)).toBe(false)
      expect(existsSync(join(tempDir, "dockerfiles", "df-delete-me"))).toBe(false)
    })
  })

  describe("POST /apps/:name/deploy - dockerfile override", () => {
    test("rejects -f override on non-dockerfile app", async () => {
      // Create a plain image-based app
      await request<App>("POST", "/apps", {
        name: "plain-image-app",
        image: "nginx:alpine",
        internalPort: 80,
      })

      const response = await fetch(`${baseUrl}/apps/plain-image-app/deploy`, {
        method: "POST",
        headers: {
          "X-API-Key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ dockerfileContent: "FROM alpine\n" }),
      })
      const result = (await response.json()) as ApiResponse<App>

      expect(result.success).toBe(false)
      expect(result.error).toContain("not created with -f")
    })
  })
})
