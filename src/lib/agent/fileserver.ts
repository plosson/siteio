import { join } from "path"
import { existsSync } from "fs"
import type { SiteStorage } from "./storage.ts"

// MIME types for common static files
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".pdf": "application/pdf",
  ".xml": "application/xml",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
}

function getMimeType(path: string): string {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase()
  return MIME_TYPES[ext] || "application/octet-stream"
}

export function createFileServerHandler(
  storage: SiteStorage,
  domain: string
) {
  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url)
    const host = req.headers.get("host") || ""

    // Extract subdomain from host
    // host could be "mysite.axel.siteio.me" or "mysite.axel.siteio.me:8080"
    const hostWithoutPort = host.split(":")[0]

    if (!hostWithoutPort) {
      return null
    }

    // Check if this is a site request (not api subdomain)
    if (!hostWithoutPort.endsWith(`.${domain}`)) {
      return null
    }

    const subdomain = hostWithoutPort.slice(0, -(domain.length + 1))

    // Skip api subdomain - it's handled by the API server
    if (subdomain === "api") {
      return null
    }

    // Check if site exists
    if (!storage.siteExists(subdomain)) {
      return new Response("Site not found", { status: 404 })
    }

    // Get the requested path
    let pathname = url.pathname
    if (pathname === "/") {
      pathname = "/index.html"
    }

    // Build the file path
    const sitePath = storage.getSitePath(subdomain)
    const filePath = join(sitePath, pathname)

    // Security: ensure the path doesn't escape the site directory
    if (!filePath.startsWith(sitePath)) {
      return new Response("Forbidden", { status: 403 })
    }

    // Check if file exists
    if (!existsSync(filePath)) {
      // Try with .html extension
      const htmlPath = filePath + ".html"
      if (existsSync(htmlPath)) {
        const file = Bun.file(htmlPath)
        return new Response(file, {
          headers: { "Content-Type": "text/html" },
        })
      }

      // Try index.html for directories
      const indexPath = join(filePath, "index.html")
      if (existsSync(indexPath)) {
        const file = Bun.file(indexPath)
        return new Response(file, {
          headers: { "Content-Type": "text/html" },
        })
      }

      return new Response("Not found", { status: 404 })
    }

    // Serve the file
    const file = Bun.file(filePath)
    const stat = await file.stat()

    // If it's a directory, try index.html
    if (stat && stat.isDirectory()) {
      const indexPath = join(filePath, "index.html")
      if (existsSync(indexPath)) {
        const indexFile = Bun.file(indexPath)
        return new Response(indexFile, {
          headers: { "Content-Type": "text/html" },
        })
      }
      return new Response("Not found", { status: 404 })
    }

    return new Response(file, {
      headers: {
        "Content-Type": getMimeType(filePath),
        "Cache-Control": "public, max-age=3600",
      },
    })
  }
}
