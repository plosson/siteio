import type { ApiResponse } from "../../types.ts"

export function jsonResponse<T>(data: T, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json({ success: true, data } as ApiResponse<T>, { status, headers })
}

// `reason` is an optional machine-readable code (see AgentServer.error).
export function errorResponse(message: string, status = 400, reason?: string): Response {
  return Response.json({ success: false, error: message, ...(reason ? { reason } : {}) } as ApiResponse<null>, { status })
}

// A JSON object body, or null for anything else (bad JSON, an array, a string).
export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json()
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}
