import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { join } from "path"

/**
 * Stores per-app Dockerfiles uploaded by the client for inline (context-less)
 * builds. Each app gets its own directory containing only a Dockerfile, which
 * doubles as the build context (intentionally empty so COPY/ADD from context
 * will fail — Dockerfiles must be self-contained).
 */
export class DockerfileStorage {
  private dockerfilesDir: string

  constructor(dataDir: string) {
    this.dockerfilesDir = join(dataDir, "dockerfiles")
  }

  /**
   * Directory containing the app's Dockerfile. Used as the docker build context.
   */
  contextPath(appName: string): string {
    return join(this.dockerfilesDir, appName)
  }

  /**
   * Full path to the stored Dockerfile.
   */
  dockerfilePath(appName: string): string {
    return join(this.contextPath(appName), "Dockerfile")
  }

  /**
   * Write (or overwrite) the Dockerfile for an app.
   */
  write(appName: string, content: string): void {
    const dir = this.contextPath(appName)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(this.dockerfilePath(appName), content)
  }

  /**
   * Check if a Dockerfile is stored for an app.
   */
  exists(appName: string): boolean {
    return existsSync(this.dockerfilePath(appName))
  }

  /**
   * Remove the Dockerfile directory for an app.
   */
  remove(appName: string): void {
    const dir = this.contextPath(appName)
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
