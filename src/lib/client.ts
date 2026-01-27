import { loadConfig } from "../config/loader.ts"
import { ApiError, ConfigError } from "../utils/errors.ts"
import type { ApiResponse, SiteInfo, SiteOAuth } from "../types.ts"

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

  async listSites(): Promise<SiteInfo[]> {
    const response = await this.request<ApiResponse<SiteInfo[]>>("GET", "/sites")
    return response.data || []
  }

  async deploySite(
    subdomain: string,
    zipData: Uint8Array,
    onProgress?: (uploaded: number, total: number) => void,
    oauth?: SiteOAuth
  ): Promise<SiteInfo> {
    // For progress tracking, we'll use XMLHttpRequest-like approach
    // But fetch doesn't support upload progress, so we'll just call onProgress at start and end
    onProgress?.(0, zipData.length)

    const headers: Record<string, string> = {
      "Content-Type": "application/zip",
      "Content-Length": String(zipData.length),
    }

    // Add OAuth headers if provided
    if (oauth) {
      if (oauth.allowedEmails && oauth.allowedEmails.length > 0) {
        headers["X-Site-OAuth-Emails"] = oauth.allowedEmails.join(",")
      }
      if (oauth.allowedDomain) {
        headers["X-Site-OAuth-Domain"] = oauth.allowedDomain
      }
    }

    const response = await this.request<ApiResponse<SiteInfo>>(
      "POST",
      `/sites/${subdomain}`,
      zipData,
      headers
    )

    onProgress?.(zipData.length, zipData.length)

    if (!response.data) {
      throw new ApiError("Invalid response from server")
    }

    return response.data
  }

  async undeploySite(subdomain: string): Promise<void> {
    await this.request<ApiResponse<null>>("DELETE", `/sites/${subdomain}`)
  }

  async updateSiteOAuth(subdomain: string, oauth: SiteOAuth | null): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }

    await this.request<ApiResponse<null>>(
      "PATCH",
      `/sites/${subdomain}/auth`,
      JSON.stringify(oauth ? oauth : { remove: true }),
      headers
    )
  }

  async getOAuthStatus(): Promise<boolean> {
    try {
      const response = await this.request<ApiResponse<{ enabled: boolean }>>("GET", "/oauth/status")
      return response.data?.enabled ?? false
    } catch {
      return false
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.request<ApiResponse<null>>("GET", "/health")
      return true
    } catch {
      return false
    }
  }
}
