import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { DockerManager } from "../../lib/agent/docker"

describe("Unit: DockerManager", () => {
  let testDir: string
  let docker: DockerManager

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "siteio-docker-test-"))
    docker = new DockerManager(testDir)
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  describe("isAvailable", () => {
    test("should detect if Docker is available", () => {
      // This test depends on the environment - Docker may or may not be installed
      const result = docker.isAvailable()
      expect(typeof result).toBe("boolean")
    })
  })

  describe("containerName", () => {
    test("should generate correct container name", () => {
      const name = docker.containerName("myapp")
      expect(name).toBe("siteio-myapp")
    })
  })

  describe("buildRunArgs", () => {
    test("should build basic run arguments", () => {
      const args = docker.buildRunArgs({
        name: "myapp",
        image: "nginx:alpine",
        internalPort: 80,
        env: {},
        volumes: [],
        restartPolicy: "unless-stopped",
        network: "siteio-network",
        labels: {},
      })

      expect(args).toContain("--name")
      expect(args).toContain("siteio-myapp")
      expect(args).toContain("--network")
      expect(args).toContain("siteio-network")
      expect(args).toContain("--restart")
      expect(args).toContain("unless-stopped")
      expect(args).toContain("-d")
      expect(args[args.length - 1]).toBe("nginx:alpine")
    })

    test("should include environment variables", () => {
      const args = docker.buildRunArgs({
        name: "myapp",
        image: "nginx:alpine",
        internalPort: 80,
        env: { NODE_ENV: "production", API_KEY: "secret" },
        volumes: [],
        restartPolicy: "unless-stopped",
        network: "siteio-network",
        labels: {},
      })

      expect(args).toContain("-e")
      expect(args).toContain("NODE_ENV=production")
      expect(args).toContain("API_KEY=secret")
    })

    test("should include volume mounts", () => {
      const args = docker.buildRunArgs({
        name: "myapp",
        image: "nginx:alpine",
        internalPort: 80,
        env: {},
        volumes: [{ name: "data", mountPath: "/app/data" }],
        restartPolicy: "unless-stopped",
        network: "siteio-network",
        labels: {},
      })

      expect(args).toContain("-v")
      expect(args.some((a) => a.includes(":/app/data"))).toBe(true)
    })

    test("should include labels", () => {
      const args = docker.buildRunArgs({
        name: "myapp",
        image: "nginx:alpine",
        internalPort: 80,
        env: {},
        volumes: [],
        restartPolicy: "unless-stopped",
        network: "siteio-network",
        labels: {
          "traefik.enable": "true",
          "traefik.http.routers.myapp.rule": "Host(`myapp.example.com`)",
        },
      })

      expect(args).toContain("-l")
      expect(args).toContain("traefik.enable=true")
    })

    test("should build run args with read-only volume", () => {
      const args = docker.buildRunArgs({
        name: "test-app",
        image: "nginx:alpine",
        internalPort: 80,
        env: {},
        volumes: [{ name: "/data/sites/mysite", mountPath: "/usr/share/nginx/html", readonly: true }],
        restartPolicy: "unless-stopped",
        network: "siteio-network",
        labels: {},
      })

      expect(args).toContain("-v")
      const vIndex = args.indexOf("-v")
      expect(args[vIndex + 1]).toBe("/data/sites/mysite:/usr/share/nginx/html:ro")
    })
  })

  describe("buildTraefikLabels", () => {
    test("builds Traefik labels with forwardAuth for OAuth", () => {
      const labels = docker.buildTraefikLabels("myapp", ["myapp.example.com"], 80, true)

      expect(labels["traefik.http.routers.siteio-myapp.middlewares"]).toBe("siteio-auth@file")
    })

    test("builds Traefik labels without forwardAuth when no OAuth", () => {
      const labels = docker.buildTraefikLabels("myapp", ["myapp.example.com"], 80, false)

      expect(labels["traefik.http.routers.siteio-myapp.middlewares"]).toBeUndefined()
    })
  })
})
