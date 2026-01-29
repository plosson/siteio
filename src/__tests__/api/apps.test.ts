import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { AgentServer } from "../../lib/agent/server"
import type { AgentConfig, ApiResponse, App, AppInfo, ContainerLogs } from "../../types"

// Helper to parse JSON responses with proper typing
async function parseJson<T>(response: Response): Promise<ApiResponse<T>> {
  return response.json() as Promise<ApiResponse<T>>
}

describe("API: Apps", () => {
  let testDir: string
  let server: AgentServer
  let baseUrl: string
  const apiKey = "test-api-key"
  const testPort = 4568

  beforeAll(async () => {
    testDir = mkdtempSync(join(tmpdir(), "siteio-apps-api-test-"))

    const config: AgentConfig = {
      domain: "test.example.com",
      apiKey,
      dataDir: testDir,
      port: testPort,
      skipTraefik: true,
      maxUploadSize: 50 * 1024 * 1024,
      httpPort: 80,
      httpsPort: 443,
    }

    server = new AgentServer(config)
    await server.start()
    baseUrl = `http://localhost:${testPort}`
  })

  afterAll(async () => {
    server.stop()
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  // Helper for requests with auth
  const request = async (method: string, path: string, body?: object, key: string = apiKey) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "X-API-Key": key,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    return { status: response.status, response }
  }

  // Helper for requests without auth
  const requestNoAuth = async (method: string, path: string, body?: object) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    })
    return { status: response.status, response }
  }

  describe("Authentication", () => {
    test("should reject requests without API key", async () => {
      const { status } = await requestNoAuth("GET", "/apps")
      expect(status).toBe(401)
    })

    test("should reject requests with wrong API key", async () => {
      const { status } = await request("GET", "/apps", undefined, "wrong-key")
      expect(status).toBe(401)
    })

    test("should accept requests with correct API key", async () => {
      const { status } = await request("GET", "/apps")
      expect(status).toBe(200)
    })
  })

  describe("GET /apps - list all apps", () => {
    test("should return empty array initially", async () => {
      const { response } = await request("GET", "/apps")
      const data = await parseJson<AppInfo[]>(response)
      expect(data.success).toBe(true)
      expect(data.data).toEqual([])
    })
  })

  describe("POST /apps - create app", () => {
    test("should create a new app", async () => {
      const appData = {
        name: "myapp",
        type: "container",
        image: "nginx:alpine",
        internalPort: 80,
        domains: ["myapp.test.example.com"],
      }

      const { response, status } = await request("POST", "/apps", appData)
      expect(status).toBe(200)

      const data = await parseJson<App>(response)
      expect(data.success).toBe(true)
      expect(data.data?.name).toBe("myapp")
      expect(data.data?.type).toBe("container")
      expect(data.data?.image).toBe("nginx:alpine")
      expect(data.data?.internalPort).toBe(80)
      expect(data.data?.status).toBe("pending")
      expect(data.data?.createdAt).toBeDefined()
    })

    test("should reject invalid app name with uppercase", async () => {
      const appData = {
        name: "MyApp",
        type: "container",
        image: "nginx:alpine",
        internalPort: 80,
        domains: [],
      }

      const { response, status } = await request("POST", "/apps", appData)
      expect(status).toBe(400)

      const data = await parseJson<null>(response)
      expect(data.success).toBe(false)
      expect(data.error).toContain("lowercase")
    })

    test("should reject invalid app name with special characters", async () => {
      const appData = {
        name: "my_app",
        type: "container",
        image: "nginx:alpine",
        internalPort: 80,
        domains: [],
      }

      const { response, status } = await request("POST", "/apps", appData)
      expect(status).toBe(400)

      const data = await parseJson<null>(response)
      expect(data.success).toBe(false)
    })

    test("should reject reserved name 'api'", async () => {
      const appData = {
        name: "api",
        type: "container",
        image: "nginx:alpine",
        internalPort: 80,
        domains: [],
      }

      const { response, status } = await request("POST", "/apps", appData)
      expect(status).toBe(400)

      const data = await parseJson<null>(response)
      expect(data.success).toBe(false)
      expect(data.error).toContain("reserved")
    })

    test("should reject duplicate app name", async () => {
      const appData = {
        name: "myapp",
        type: "container",
        image: "redis:alpine",
        internalPort: 6379,
        domains: [],
      }

      const { response, status } = await request("POST", "/apps", appData)
      expect(status).toBe(400)

      const data = await parseJson<null>(response)
      expect(data.success).toBe(false)
      expect(data.error).toContain("already exists")
    })

    test("should reject missing required fields", async () => {
      const appData = {
        name: "incomplete",
      }

      const { response, status } = await request("POST", "/apps", appData)
      expect(status).toBe(400)

      const data = await parseJson<null>(response)
      expect(data.success).toBe(false)
    })
  })

  describe("GET /apps - list apps after creation", () => {
    test("should list created apps", async () => {
      const { response } = await request("GET", "/apps")
      const data = await parseJson<AppInfo[]>(response)
      expect(data.success).toBe(true)
      expect(data.data?.length).toBe(1)
      expect(data.data?.[0]?.name).toBe("myapp")
    })
  })

  describe("GET /apps/:name - get app details", () => {
    test("should return app details", async () => {
      const { response, status } = await request("GET", "/apps/myapp")
      expect(status).toBe(200)

      const data = await parseJson<App>(response)
      expect(data.success).toBe(true)
      expect(data.data?.name).toBe("myapp")
      expect(data.data?.image).toBe("nginx:alpine")
    })

    test("should return 404 for non-existent app", async () => {
      const { response, status } = await request("GET", "/apps/nonexistent")
      expect(status).toBe(404)

      const data = await parseJson<null>(response)
      expect(data.success).toBe(false)
      expect(data.error).toContain("not found")
    })
  })

  describe("PATCH /apps/:name - update app config", () => {
    test("should update app configuration", async () => {
      const updates = {
        image: "nginx:latest",
        env: { NODE_ENV: "production" },
      }

      const { response, status } = await request("PATCH", "/apps/myapp", updates)
      expect(status).toBe(200)

      const data = await parseJson<App>(response)
      expect(data.success).toBe(true)
      expect(data.data?.image).toBe("nginx:latest")
      expect(data.data?.env?.NODE_ENV).toBe("production")
    })

    test("should return 404 for non-existent app", async () => {
      const updates = { image: "nginx:latest" }
      const { response, status } = await request("PATCH", "/apps/nonexistent", updates)
      expect(status).toBe(404)

      const data = await parseJson<null>(response)
      expect(data.success).toBe(false)
    })

    test("should preserve fields not being updated", async () => {
      // First get the current state
      const { response: getResponse } = await request("GET", "/apps/myapp")
      const getDataBefore = await parseJson<App>(getResponse)
      const originalInternalPort = getDataBefore.data?.internalPort

      // Update only the domains
      const updates = {
        domains: ["new.test.example.com"],
      }

      const { response } = await request("PATCH", "/apps/myapp", updates)
      const data = await parseJson<App>(response)

      expect(data.data?.internalPort).toBe(originalInternalPort)
      expect(data.data?.domains).toEqual(["new.test.example.com"])
    })
  })

  describe("POST /apps/:name/deploy - deploy app", () => {
    test("should return 404 for non-existent app", async () => {
      const { response, status } = await request("POST", "/apps/nonexistent/deploy")
      expect(status).toBe(404)
    })

    // Note: Actually deploying requires Docker, which may not be available in tests
    // The handler should exist and return appropriate response
  })

  describe("POST /apps/:name/stop - stop app", () => {
    test("should return 404 for non-existent app", async () => {
      const { response, status } = await request("POST", "/apps/nonexistent/stop")
      expect(status).toBe(404)
    })
  })

  describe("POST /apps/:name/restart - restart app", () => {
    test("should return 404 for non-existent app", async () => {
      const { response, status } = await request("POST", "/apps/nonexistent/restart")
      expect(status).toBe(404)
    })
  })

  describe("GET /apps/:name/logs - get app logs", () => {
    test("should return 404 for non-existent app", async () => {
      const { response, status } = await request("GET", "/apps/nonexistent/logs")
      expect(status).toBe(404)
    })
  })

  describe("DELETE /apps/:name - delete app", () => {
    test("should return 404 for non-existent app", async () => {
      const { response, status } = await request("DELETE", "/apps/nonexistent")
      expect(status).toBe(404)

      const data = await parseJson<null>(response)
      expect(data.success).toBe(false)
    })

    test("should delete existing app", async () => {
      const { response, status } = await request("DELETE", "/apps/myapp")
      expect(status).toBe(200)

      const data = await parseJson<null>(response)
      expect(data.success).toBe(true)
    })

    test("should not list deleted app", async () => {
      const { response } = await request("GET", "/apps")
      const data = await parseJson<AppInfo[]>(response)
      expect(data.success).toBe(true)
      expect(data.data).toEqual([])
    })
  })

  describe("Create another app for additional tests", () => {
    test("should create app with full configuration", async () => {
      const appData = {
        name: "full-app",
        type: "container",
        image: "node:18-alpine",
        internalPort: 3000,
        domains: ["full-app.test.example.com"],
        env: { NODE_ENV: "development", PORT: "3000" },
        volumes: [{ name: "data", mountPath: "/app/data" }],
        restartPolicy: "unless-stopped",
      }

      const { response, status } = await request("POST", "/apps", appData)
      expect(status).toBe(200)

      const data = await parseJson<App>(response)
      expect(data.success).toBe(true)
      expect(data.data?.env?.NODE_ENV).toBe("development")
      expect(data.data?.volumes?.[0]?.name).toBe("data")
      expect(data.data?.restartPolicy).toBe("unless-stopped")
    })

    // Cleanup
    test("should cleanup test app", async () => {
      const { status } = await request("DELETE", "/apps/full-app")
      expect(status).toBe(200)
    })
  })
})
