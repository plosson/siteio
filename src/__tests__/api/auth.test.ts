import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { AgentServer } from "../../lib/agent/server.ts"
import { mkdirSync, rmSync, existsSync } from "fs"
import { join } from "path"

describe("API: Auth", () => {
  const TEST_DATA_DIR = join(import.meta.dir, ".test-data-auth-check")
  const TEST_API_KEY = "test-api-key-auth"
  const TEST_DOMAIN = "test.siteio.me"
  let server: AgentServer
  let baseUrl: string

  beforeAll(async () => {
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true })
    }
    mkdirSync(TEST_DATA_DIR, { recursive: true })

    server = new AgentServer({
      domain: TEST_DOMAIN,
      apiKey: TEST_API_KEY,
      dataDir: TEST_DATA_DIR,
      maxUploadSize: 10 * 1024 * 1024,
      skipTraefik: true,
      port: 3098,
      httpPort: 80,
      httpsPort: 443,
    })

    await server.start()
    baseUrl = "http://localhost:3098"
  })

  afterAll(() => {
    server.stop()
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true })
    }
  })

  beforeEach(() => {
    const appsDir = join(TEST_DATA_DIR, "apps")
    if (existsSync(appsDir)) {
      rmSync(appsDir, { recursive: true })
    }
    mkdirSync(appsDir, { recursive: true })
  })

  it("returns 200 for app without OAuth", async () => {
    const createRes = await fetch(`${baseUrl}/apps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": TEST_API_KEY,
      },
      body: JSON.stringify({
        name: "public-app",
        image: "nginx:alpine",
        internalPort: 80,
      }),
    })
    expect(createRes.ok).toBe(true)

    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        "Host": `public-app.${TEST_DOMAIN}`,
      },
    })
    expect(checkRes.status).toBe(200)
  })

  it("returns 401 when OAuth required but no email header", async () => {
    const createRes = await fetch(`${baseUrl}/apps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": TEST_API_KEY,
      },
      body: JSON.stringify({
        name: "protected-app",
        image: "nginx:alpine",
        internalPort: 80,
        oauth: {
          allowedEmails: ["allowed@example.com"],
        },
      }),
    })
    expect(createRes.ok).toBe(true)

    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        "Host": `protected-app.${TEST_DOMAIN}`,
      },
    })
    expect(checkRes.status).toBe(401)
  })

  it("returns 200 when email is in allowedEmails", async () => {
    await fetch(`${baseUrl}/apps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": TEST_API_KEY,
      },
      body: JSON.stringify({
        name: "email-app",
        image: "nginx:alpine",
        internalPort: 80,
        oauth: {
          allowedEmails: ["allowed@example.com"],
        },
      }),
    })

    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        "Host": `email-app.${TEST_DOMAIN}`,
        "X-Forwarded-Email": "allowed@example.com",
      },
    })
    expect(checkRes.status).toBe(200)
  })

  it("returns 403 when email not in allowedEmails", async () => {
    await fetch(`${baseUrl}/apps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": TEST_API_KEY,
      },
      body: JSON.stringify({
        name: "restricted-app",
        image: "nginx:alpine",
        internalPort: 80,
        oauth: {
          allowedEmails: ["allowed@example.com"],
        },
      }),
    })

    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        "Host": `restricted-app.${TEST_DOMAIN}`,
        "X-Forwarded-Email": "notallowed@example.com",
      },
    })
    expect(checkRes.status).toBe(403)
  })

  it("returns 200 when email matches allowedDomain", async () => {
    await fetch(`${baseUrl}/apps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": TEST_API_KEY,
      },
      body: JSON.stringify({
        name: "domain-app",
        image: "nginx:alpine",
        internalPort: 80,
        oauth: {
          allowedDomain: "company.com",
        },
      }),
    })

    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        "Host": `domain-app.${TEST_DOMAIN}`,
        "X-Forwarded-Email": "employee@company.com",
      },
    })
    expect(checkRes.status).toBe(200)
  })

  it("returns 200 for app not found (passthrough)", async () => {
    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        "Host": `nonexistent.${TEST_DOMAIN}`,
      },
    })
    expect(checkRes.status).toBe(200)
  })

  it("returns 200 when using X-Auth-Request-Email header (forwardAuth mode)", async () => {
    await fetch(`${baseUrl}/apps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": TEST_API_KEY,
      },
      body: JSON.stringify({
        name: "forward-auth-app",
        image: "nginx:alpine",
        internalPort: 80,
        oauth: {
          allowedEmails: ["forward@example.com"],
        },
      }),
    })

    const checkRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        "Host": `forward-auth-app.${TEST_DOMAIN}`,
        "X-Auth-Request-Email": "forward@example.com",
      },
    })
    expect(checkRes.status).toBe(200)
  })

  it("returns 200 when oauth is empty object (allow all authenticated)", async () => {
    await fetch(`${baseUrl}/apps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": TEST_API_KEY,
      },
      body: JSON.stringify({
        name: "any-auth-app",
        image: "nginx:alpine",
        internalPort: 80,
        oauth: {},
      }),
    })

    // Without email header, should return 401
    const unauthRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        "Host": `any-auth-app.${TEST_DOMAIN}`,
      },
    })
    expect(unauthRes.status).toBe(401)

    // With email header, should return 200 (any authenticated user allowed)
    const authRes = await fetch(`${baseUrl}/auth/check`, {
      headers: {
        "Host": `any-auth-app.${TEST_DOMAIN}`,
        "X-Forwarded-Email": "anyone@anywhere.com",
      },
    })
    expect(authRes.status).toBe(200)
  })
})
