import { loadConfig } from "../config/loader.ts"
import { ApiError, ConfigError } from "../utils/errors.ts"
import type {
  ApiResponse, SiteInfo, SiteVersion, App, AppInfo, ContainerLogs, ShareGrantInfo, ShareGrantCreated,
} from "../types.ts"

export interface ClientOptions {
  apiUrl?: string
  apiKey?: string
}

export class SiteioClient {
  private apiUrl: string
  private apiKey: string

  constructor(options: ClientOptions = {}) {
    const config = loadConfig()
    this.apiUrl = options.apiUrl || config.apiUrl || ""
    this.apiKey = options.apiKey || config.apiKey || ""

    if (!this.apiUrl) {
      throw new ConfigError("API URL not configured. Run 'siteio login' first.")
    }
    if (!this.apiKey) {
      throw new ConfigError("API key not configured. Run 'siteio login' first.")
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Uint8Array | string | null,
    headers?: Record<string, string>
  ): Promise<T> {
    const url = `${this.apiUrl}${path}`
    const response = await fetch(url, {
      method,
      headers: {
        "X-API-Key": this.apiKey,
        ...headers,
      },
      body,
    })

    if (!response.ok) {
      const text = await response.text()
      let message = `API error: ${response.status}`
      try {
        const json = JSON.parse(text) as ApiResponse<unknown>
        if (json.error) message = json.error
      } catch {
        if (text) message = text
      }
      throw new ApiError(message, response.status)
    }

    return response.json() as Promise<T>
  }

  // Like request(), but returns the raw response bytes (for zip downloads).
  private async requestBytes(path: string): Promise<Uint8Array> {
    const response = await fetch(`${this.apiUrl}${path}`, {
      method: "GET",
      headers: { "X-API-Key": this.apiKey },
    })

    if (!response.ok) {
      const text = await response.text()
      let message = `API error: ${response.status}`
      try {
        const json = JSON.parse(text) as ApiResponse<unknown>
        if (json.error) message = json.error
      } catch {
        if (text) message = text
      }
      throw new ApiError(message, response.status)
    }

    return new Uint8Array(await response.arrayBuffer())
  }

  // Sites API

  async deploySite(
    name: string,
    zipData: Uint8Array,
    opts?: { deployedBy?: string; expectedVersion?: number }
  ): Promise<SiteInfo> {
    const headers: Record<string, string> = {
      "Content-Type": "application/zip",
      "Content-Length": String(zipData.length),
    }
    if (opts?.deployedBy) headers["X-Deployed-By"] = opts.deployedBy
    if (opts?.expectedVersion !== undefined) {
      headers["X-Expected-Version"] = String(opts.expectedVersion)
    }
    const response = await this.request<ApiResponse<SiteInfo>>("POST", `/sites/${name}`, zipData, headers)
    if (!response.data) throw new ApiError("Invalid response from server")
    return response.data
  }

  async listSites(): Promise<SiteInfo[]> {
    const response = await this.request<ApiResponse<SiteInfo[]>>("GET", "/sites")
    return response.data || []
  }

  async getSite(name: string): Promise<SiteInfo> {
    const response = await this.request<ApiResponse<SiteInfo>>("GET", `/sites/${name}`)
    if (!response.data) throw new ApiError("Invalid response from server")
    return response.data
  }

  async deleteSite(name: string): Promise<void> {
    await this.request<ApiResponse<{ deleted: boolean }>>("DELETE", `/sites/${name}`)
  }

  async downloadSite(name: string): Promise<Uint8Array> {
    return this.requestBytes(`/sites/${name}/download`)
  }

  async getSiteLogs(name: string, tail: number = 100): Promise<ContainerLogs> {
    const response = await this.request<ApiResponse<ContainerLogs>>("GET", `/sites/${name}/logs?tail=${tail}`)
    if (!response.data) throw new ApiError("Invalid response from server")
    return response.data
  }

  async getSiteAdmin(name: string): Promise<{ email: string; password: string; adminUrl: string }> {
    const response = await this.request<ApiResponse<{ email: string; password: string; adminUrl: string }>>("GET", `/sites/${name}/admin`)
    if (!response.data) throw new ApiError("Invalid response from server")
    return response.data
  }

  async getSiteHistory(name: string): Promise<SiteVersion[]> {
    const response = await this.request<ApiResponse<SiteVersion[]>>("GET", `/sites/${name}/history`)
    return response.data || []
  }

  async rollbackSite(name: string, version: number): Promise<SiteInfo> {
    const response = await this.request<ApiResponse<SiteInfo>>(
      "POST",
      `/sites/${name}/rollback`,
      JSON.stringify({ version }),
      { "Content-Type": "application/json" }
    )
    if (!response.data) throw new ApiError("Invalid response from server")
    return response.data
  }

  async updateSiteDomains(name: string, domains: string[]): Promise<SiteInfo> {
    const response = await this.request<ApiResponse<SiteInfo>>(
      "PATCH",
      `/sites/${name}/domains`,
      JSON.stringify({ domains }),
      { "Content-Type": "application/json" }
    )
    if (!response.data) throw new ApiError("Invalid response from server")
    return response.data
  }

  async renameSite(name: string, newName: string): Promise<SiteInfo> {
    const response = await this.request<ApiResponse<SiteInfo>>(
      "PATCH",
      `/sites/${name}/rename`,
      JSON.stringify({ newSubdomain: newName }),
      { "Content-Type": "application/json" }
    )
    if (!response.data) throw new ApiError("Invalid response from server")
    return response.data
  }

  // Share links (MCP grants)

  async createGrant(
    site: string,
    opts: { maxDeploys?: number; expiresInMs?: number; label?: string } = {}
  ): Promise<ShareGrantCreated> {
    const response = await this.request<ApiResponse<ShareGrantCreated>>(
      "POST",
      `/sites/${site}/grants`,
      JSON.stringify(opts),
      { "Content-Type": "application/json" }
    )
    if (!response.data) throw new ApiError("Invalid response from server")
    return response.data
  }

  async listGrants(site: string): Promise<ShareGrantInfo[]> {
    const response = await this.request<ApiResponse<ShareGrantInfo[]>>("GET", `/sites/${site}/grants`)
    return response.data || []
  }

  async revokeGrant(site: string, id: string): Promise<void> {
    await this.request<ApiResponse<{ revoked: boolean }>>("DELETE", `/sites/${site}/grants/${id}`)
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.request<ApiResponse<null>>("GET", "/health")
      return true
    } catch {
      return false
    }
  }

  // The agent's software version, or null for pre-merge agents whose /health
  // response carried no version. Used to fail fast before deploying with a
  // zip layout an old agent would extract literally.
  async getServerVersion(): Promise<string | null> {
    try {
      const response = await this.request<ApiResponse<{ status: string; version?: string }>>("GET", "/health")
      return response.data?.version ?? null
    } catch {
      return null
    }
  }

  // Apps API

  async createApp(config: {
    name: string
    image?: string
    git?: {
      repoUrl: string
      branch?: string
      dockerfile?: string
      context?: string
      token?: string
    }
    dockerfileContent?: string
    composeContent?: string
    envFileContent?: string
    composePath?: string
    primaryService?: string
    internalPort?: number
    env?: Record<string, string>
    volumes?: { name: string; mountPath: string }[]
    domains?: string[]
    restartPolicy?: string
  }): Promise<AppInfo> {
    const response = await this.request<ApiResponse<AppInfo>>(
      "POST",
      "/apps",
      JSON.stringify(config),
      { "Content-Type": "application/json" }
    )
    if (!response.data) {
      throw new ApiError("Invalid response from server")
    }
    return response.data
  }

  async listApps(): Promise<AppInfo[]> {
    const response = await this.request<ApiResponse<AppInfo[]>>("GET", "/apps")
    return response.data || []
  }

  async getApp(name: string): Promise<App> {
    const response = await this.request<ApiResponse<App>>("GET", `/apps/${name}`)
    if (!response.data) {
      throw new ApiError("Invalid response from server")
    }
    return response.data
  }

  async updateApp(
    name: string,
    updates: {
      env?: Record<string, string>
      unsetEnv?: string[]
      volumes?: { name: string; mountPath: string }[]
      domains?: string[]
      internalPort?: number
      restartPolicy?: string
      image?: string
      git?: { repoUrl?: string; branch?: string; dockerfile?: string; context?: string; token?: string }
    }
  ): Promise<App> {
    const response = await this.request<ApiResponse<App>>(
      "PATCH",
      `/apps/${name}`,
      JSON.stringify(updates),
      { "Content-Type": "application/json" }
    )
    if (!response.data) {
      throw new ApiError("Invalid response from server")
    }
    return response.data
  }

  async deleteApp(name: string): Promise<void> {
    await this.request<ApiResponse<{ deleted: boolean }>>("DELETE", `/apps/${name}`)
  }

  async deployApp(
    name: string,
    options?: { noCache?: boolean; dockerfileContent?: string }
  ): Promise<AppInfo> {
    const queryParams = options?.noCache ? "?noCache=true" : ""
    const hasBody = options?.dockerfileContent !== undefined
    const response = await this.request<ApiResponse<AppInfo>>(
      "POST",
      `/apps/${name}/deploy${queryParams}`,
      hasBody ? JSON.stringify({ dockerfileContent: options!.dockerfileContent }) : undefined,
      hasBody ? { "Content-Type": "application/json" } : undefined
    )
    if (!response.data) {
      throw new ApiError("Invalid response from server")
    }
    return response.data
  }

  async stopApp(name: string): Promise<AppInfo> {
    const response = await this.request<ApiResponse<AppInfo>>("POST", `/apps/${name}/stop`)
    if (!response.data) {
      throw new ApiError("Invalid response from server")
    }
    return response.data
  }

  async restartApp(name: string): Promise<AppInfo> {
    const response = await this.request<ApiResponse<AppInfo>>("POST", `/apps/${name}/restart`)
    if (!response.data) {
      throw new ApiError("Invalid response from server")
    }
    return response.data
  }

  async getAppLogs(
    name: string,
    opts: { tail?: number; service?: string; all?: boolean } = {}
  ): Promise<ContainerLogs> {
    const params = new URLSearchParams()
    params.set("tail", String(opts.tail ?? 100))
    if (opts.service) params.set("service", opts.service)
    if (opts.all) params.set("all", "true")
    const response = await this.request<ApiResponse<ContainerLogs>>(
      "GET",
      `/apps/${name}/logs?${params.toString()}`
    )
    if (!response.data) {
      throw new ApiError("Invalid response from server")
    }
    return response.data
  }

}
