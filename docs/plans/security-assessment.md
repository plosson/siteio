# Security Assessment: siteio Codebase

**Date**: 2026-01-29
**Status**: Review Complete - Remediation Pending

## Executive Summary

| Severity | Count |
|----------|-------|
| **CRITICAL** | 3 |
| **MODERATE** | 7 |
| **LOW** | 4 |

---

## CRITICAL Issues

### 1. Path Traversal in Zip Extraction

**File**: `src/lib/agent/storage.ts:53-68`

Zip filenames are not validated for `../` sequences. A malicious zip could write files anywhere on the filesystem.

```typescript
// Current - no validation
const filePath = join(sitePath, filename)
await Bun.write(filePath, data)
```

**Remediation**: Validate resolved path stays within `sitePath`:

```typescript
const resolvedPath = path.resolve(sitePath, filename)
if (!resolvedPath.startsWith(path.resolve(sitePath) + path.sep)) {
  throw new Error("Path traversal detected")
}
```

---

### 2. API Key Exposed in Logs

**File**: `src/lib/agent/server.ts:718`

```typescript
console.log(`> API Key: ${this.config.apiKey}`)
```

**Remediation**: Remove or mask:

```typescript
console.log(`> API Key: ****${this.config.apiKey.slice(-4)}`)
```

---

### 3. No Rate Limiting

**File**: `src/lib/agent/server.ts`

No rate limiting on any endpoints enables brute-force and DoS attacks.

**Remediation**: Implement per-IP rate limiting (e.g., 100 req/min for general endpoints, 10 req/min for auth attempts).

---

## MODERATE Issues

| Issue | File | Line | Remediation |
|-------|------|------|-------------|
| Missing email validation | `server.ts` | 269, 369 | Add regex: `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` |
| Missing port validation | `server.ts` | 517-518 | Validate range 1-65535 |
| Missing image name validation | `server.ts` | 513-514 | Validate Docker image format |
| Unbounded tail parameter | `server.ts` | 683 | Cap at 10,000: `Math.min(tail, 10000)` |
| Sensitive error messages | `server.ts` | 292-295 | Return generic messages, log details server-side |
| Weak path check in fileserver | `fileserver.ts` | 144-146 | Use `path.relative()` check |
| OAuth config file permissions | `config/oauth.ts` | 44 | Write with mode `0o600` |

---

## LOW Issues

| Issue | File | Remediation |
|-------|------|-------------|
| Missing security headers | `fileserver.ts` | Add X-Frame-Options, X-Content-Type-Options, CSP |
| Potential YAML injection | `traefik.ts:124-125` | Escape special chars in subdomain/domain |
| No HTTPS enforcement | `start.ts:76` | Validate `apiUrl` starts with `https://` |
| Missing domain validation | `server.ts:271-272` | Validate domain format |

---

## Remediation Plan (Priority Order)

| Phase | Issues | Effort |
|-------|--------|--------|
| **Phase 1** | Path traversal (zip), API key in logs | High priority |
| **Phase 2** | Rate limiting implementation | Medium effort |
| **Phase 3** | Input validation (email, port, image, tail) | Low effort |
| **Phase 4** | Error message sanitization, file permissions | Low effort |
| **Phase 5** | Security headers, path check improvement | Low effort |

---

## What's Done Well

- API key comparison is safe (no timing attacks)
- Docker commands use array arguments (no shell injection)
- File upload validates Content-Type and Content-Length
- Public endpoints are appropriately limited (only /health and /oauth/status)

---

## Detailed Findings

### Secrets Management

**CRITICAL - API Key Exposure in Logs**
- **File**: `src/lib/agent/server.ts:718`
- **Issue**: API key is printed to console in plaintext during agent startup
- **Impact**: The API key is exposed in server logs and shell history

**MODERATE - OAuth Config File Permissions**
- **File**: `src/config/oauth.ts:44`
- **Issue**: `oauth-config.json` containing clientSecret and cookieSecret is written without restrictive permissions
- **Remediation**: Write with `0600` permissions: `writeFileSync(path, data, { mode: 0o600 })`

---

### Input Validation

**Missing Email Format Validation**
- **File**: `src/lib/agent/server.ts:269, 369`
- **Issue**: Email addresses are only lowercased but not validated for proper format
- **Impact**: Invalid email formats accepted without validation

**Missing Port Validation**
- **File**: `src/lib/agent/server.ts:517-518`
- **Issue**: Port numbers are not validated for valid ranges (1-65535)

**Missing Docker Image Validation**
- **File**: `src/lib/agent/server.ts:513-514`
- **Issue**: Docker image names are not validated before being passed to Docker

**Unbounded Tail Parameter**
- **File**: `src/lib/agent/server.ts:683`
- **Issue**: The `tail` parameter from query string is not bounded
- **Impact**: Memory/performance issues with large values

---

### Path Traversal

**CRITICAL - Zip Extraction**
- **File**: `src/lib/agent/storage.ts:53-68`
- **Issue**: When extracting zip files, filenames are not checked for path traversal sequences
- **Impact**: A malicious zip with paths like `../../etc/passwd` could extract files outside the intended directory

**MODERATE - String-based Path Check in File Server**
- **File**: `src/lib/agent/fileserver.ts:144-146`
- **Issue**: String comparison can be bypassed with symbolic links or Unicode normalization
- **Better Approach**: Use `path.relative()` to verify the path is within bounds

---

### Error Handling

**Sensitive Information in Error Messages**
- **File**: `src/lib/agent/server.ts:292-295, 334-336`
- **Issue**: Error messages from internal operations are directly returned to clients
- **Impact**: Stack traces or detailed error messages could leak information about internal architecture

---

### Security Headers

**Missing HTTP Security Headers**
- **File**: `src/lib/agent/fileserver.ts`
- **Issue**: Static file responses don't include security headers
- **Recommended Headers**:
  - `X-Frame-Options: DENY`
  - `X-Content-Type-Options: nosniff`
  - `X-XSS-Protection: 1; mode=block`
  - `Content-Security-Policy: default-src 'self'`

---

### Traefik Configuration

**Potential YAML Injection**
- **File**: `src/lib/agent/traefik.ts:124-125`
- **Issue**: If a subdomain or domain contains backticks or special characters, it could break the Traefik YAML syntax
- **Remediation**: Escape special characters in domain/subdomain values before inserting into template strings
