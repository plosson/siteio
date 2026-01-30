import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { DockerManager } from "../../lib/agent/docker"

function isDockerAvailable(): boolean {
  const result = Bun.spawnSync({ cmd: ["docker", "info"], stdout: "pipe", stderr: "pipe" })
  return result.exitCode === 0
}

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

  describe("build", () => {
    test("should build image from Dockerfile in context subdirectory", async () => {
      if (!isDockerAvailable()) {
        console.log("Test skipped: Docker not available")
        return
      }

      // Create a context directory structure: repo/services/api/Dockerfile
      const repoDir = join(testDir, "repo")
      const contextDir = join(repoDir, "services", "api")
      mkdirSync(contextDir, { recursive: true })

      // Create a minimal Dockerfile
      writeFileSync(
        join(contextDir, "Dockerfile"),
        `FROM alpine:latest
CMD ["echo", "hello"]
`
      )

      const tag = "siteio-build-test:latest"

      // This should work - the fix ensures dockerfile path is joined with contextPath
      const result = await docker.build({
        contextPath: contextDir,
        dockerfile: "Dockerfile",
        tag,
      })

      expect(result).toBe(tag)

      // Verify image was created
      expect(docker.imageExists(tag)).toBe(true)

      // Cleanup
      await docker.removeImage(tag)
    })

    test("should build image with nested Dockerfile path in context", async () => {
      if (!isDockerAvailable()) {
        console.log("Test skipped: Docker not available")
        return
      }

      // Create context with Dockerfile in a subdirectory: context/docker/Dockerfile.prod
      const contextDir = join(testDir, "myapp")
      const dockerDir = join(contextDir, "docker")
      mkdirSync(dockerDir, { recursive: true })

      writeFileSync(
        join(dockerDir, "Dockerfile.prod"),
        `FROM alpine:latest
CMD ["echo", "production"]
`
      )

      const tag = "siteio-nested-dockerfile-test:latest"

      const result = await docker.build({
        contextPath: contextDir,
        dockerfile: "docker/Dockerfile.prod",
        tag,
      })

      expect(result).toBe(tag)
      expect(docker.imageExists(tag)).toBe(true)

      // Cleanup
      await docker.removeImage(tag)
    })

    test("should fail when Dockerfile does not exist", async () => {
      if (!isDockerAvailable()) {
        console.log("Test skipped: Docker not available")
        return
      }

      const contextDir = join(testDir, "empty-context")
      mkdirSync(contextDir, { recursive: true })

      await expect(
        docker.build({
          contextPath: contextDir,
          dockerfile: "Dockerfile",
          tag: "should-not-exist:latest",
        })
      ).rejects.toThrow()
    })

    test("should pass --no-cache flag when specified", async () => {
      if (!isDockerAvailable()) {
        console.log("Test skipped: Docker not available")
        return
      }

      const contextDir = join(testDir, "nocache-test")
      mkdirSync(contextDir, { recursive: true })

      writeFileSync(
        join(contextDir, "Dockerfile"),
        `FROM alpine:latest
CMD ["echo", "no-cache-test"]
`
      )

      const tag = "siteio-nocache-test:latest"

      // Build with no-cache
      const result = await docker.build({
        contextPath: contextDir,
        dockerfile: "Dockerfile",
        tag,
        noCache: true,
      })

      expect(result).toBe(tag)
      expect(docker.imageExists(tag)).toBe(true)

      // Cleanup
      await docker.removeImage(tag)
    })
  })
})
