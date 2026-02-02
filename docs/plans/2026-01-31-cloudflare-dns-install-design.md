# Cloudflare DNS Auto-Setup for Install Command

## Summary

Add optional Cloudflare integration to `siteio agent install` that automatically creates a wildcard DNS record pointing to the server's public IP.

## User Flow

```
? Domain for this agent: myserver.example.com
? Data directory: /data
? Email for Let's Encrypt (optional): admin@example.com
? Cloudflare API token (optional, for auto DNS setup): ••••••••
```

If token provided:
1. Fetch public IP from `https://api.ipify.org`
2. List zones accessible by the token
3. Find matching zone (e.g., `example.com` for `myserver.example.com`)
4. Check if `*.myserver.example.com` exists
   - Exists: skip with warning
   - Missing: create A record
5. Continue with normal install

## Implementation

### New File: `src/lib/cloudflare.ts`

```typescript
async function getPublicIP(): Promise<string>
async function listZones(token: string): Promise<Zone[]>
function findMatchingZone(domain: string, zones: Zone[]): Zone | null
async function getRecord(token: string, zoneId: string, name: string): Promise<DNSRecord | null>
async function createARecord(token: string, zoneId: string, name: string, ip: string): Promise<void>
```

### Changes to `install.ts`

- Add `cloudflareToken?: string` to `InstallOptions`
- Add optional password-masked prompt for Cloudflare token
- Add `--cloudflare-token` CLI flag
- Call DNS setup after gathering config, before creating data directory
- Pass token to remote install if provided

### Cloudflare API Endpoints

- `GET /zones` - list zones
- `GET /zones/:id/dns_records?name=...` - check existing record
- `POST /zones/:id/dns_records` - create record

## Error Handling

DNS setup failures do NOT block installation. The agent works without it - user just configures DNS manually.

| Scenario | Behavior |
|----------|----------|
| Invalid/expired token | Warn, continue without DNS |
| No matching zone | Show available zones, continue without DNS |
| API error | Warn, continue without DNS |
| Network error (IP fetch) | Warn, continue without DNS |
| Record already exists | Skip with warning showing existing IP |

## Output Messages

- Success: `✓ Created DNS record *.myserver.example.com → 203.0.113.42`
- Skip: `⚠ DNS record *.myserver.example.com already exists (pointing to 1.2.3.4), skipping`
- Error: `⚠ Could not set up DNS: <reason>. Please configure manually.`
