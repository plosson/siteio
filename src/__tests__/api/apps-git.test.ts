import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { AgentServer } from "../../lib/agent/server"
import { mkdtempSync, rmSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import type { ApiResponse, App, AppInfo, AgentConfig } from "../../types"

describe("Apps API - Git Source", () => {
  let server: AgentServer
  let tempDir: string
  let baseUrl: string
  const apiKey = "git-apps-test-key"
  const testPort = 4569

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "siteio-git-apps-test-"))

    const config: AgentConfig = {
      apiKey,
      dataDir: tempDir,
      domain: "git-test.local",
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

  describe("POST /apps - create with git source", () => {
    test("creates app with git source", async () => {
      const result = await request<App>("POST", "/apps", {
        name: "git-app",
        git: {
          repoUrl: "https://github.com/user/repo",
          branch: "main",
          dockerfile: "Dockerfile",
        },
        internalPort: 3000,
      })

      expect(result.success).toBe(true)
      expect(result.data?.name).toBe("git-app")
      expect(result.data?.git?.repoUrl).toBe("https://github.com/user/repo")
      expect(result.data?.git?.branch).toBe("main")
      expect(result.data?.git?.dockerfile).toBe("Dockerfile")
      expect(result.data?.image).toBe("siteio-git-app:latest")
    })

    test("creates app with git source and custom options", async () => {
      const result = await request<App>("POST", "/apps", {
        name: "git-app-custom",
        git: {
          repoUrl: "https://github.com/user/monorepo",
          branch: "develop",
          dockerfile: "docker/Dockerfile.prod",
          context: "services/api",
        },
        internalPort: 8080,
      })

      expect(result.success).toBe(true)
      expect(result.data?.git?.branch).toBe("develop")
      expect(result.data?.git?.dockerfile).toBe("docker/Dockerfile.prod")
      expect(result.data?.git?.context).toBe("services/api")
    })

    test("uses default branch and dockerfile when not specified", async () => {
      const result = await request<App>("POST", "/apps", {
        name: "git-app-defaults",
        git: {
          repoUrl: "https://github.com/user/repo",
        },
        internalPort: 80,
      })

      expect(result.success).toBe(true)
      expect(result.data?.git?.branch).toBe("main")
      expect(result.data?.git?.dockerfile).toBe("Dockerfile")
    })

    test("rejects when both image and git are provided", async () => {
      const result = await request<App>("POST", "/apps", {
        name: "invalid-app",
        image: "nginx:alpine",
        git: {
          repoUrl: "https://github.com/user/repo",
        },
        internalPort: 80,
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain("Cannot specify both")
    })

    test("rejects when neither image nor git is provided", async () => {
      const result = await request<App>("POST", "/apps", {
        name: "no-source-app",
        internalPort: 80,
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain("Either image or git")
    })

    test("rejects git source without repoUrl", async () => {
      const result = await request<App>("POST", "/apps", {
        name: "no-url-app",
        git: {
          branch: "main",
        },
        internalPort: 80,
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain("repository URL is required")
    })
  })

  describe("GET /apps - list with git source", () => {
    test("lists apps with git info", async () => {
      const result = await request<AppInfo[]>("GET", "/apps")

      expect(result.success).toBe(true)
      expect(result.data).toBeDefined()

      const gitApp = result.data?.find((a) => a.name === "git-app")
      expect(gitApp).toBeDefined()
      expect(gitApp?.git?.repoUrl).toBe("https://github.com/user/repo")
    })
  })

  describe("GET /apps/:name - get with git source", () => {
    test("returns app with git source details", async () => {
      const result = await request<App>("GET", "/apps/git-app")

      expect(result.success).toBe(true)
      expect(result.data?.git?.repoUrl).toBe("https://github.com/user/repo")
      expect(result.data?.git?.branch).toBe("main")
    })
  })

  describe("DELETE /apps/:name - delete git-based app", () => {
    test("deletes git-based app", async () => {
      // Create a temporary app
      await request<App>("POST", "/apps", {
        name: "git-delete-test",
        git: {
          repoUrl: "https://github.com/user/repo",
        },
        internalPort: 80,
      })

      // Delete it
      const result = await request<null>("DELETE", "/apps/git-delete-test")
      expect(result.success).toBe(true)

      // Verify it's gone
      const getResult = await request<App>("GET", "/apps/git-delete-test")
      expect(getResult.success).toBe(false)
    })
  })
})
