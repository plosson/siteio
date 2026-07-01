import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, cpSync,
} from "fs"
import { join, resolve, sep } from "path"
import { unzipSync } from "fflate"
import type { Pocket, PocketInfo } from "../../types.ts"
import { ValidationError } from "../../utils/errors.ts"

const MAX_HISTORY_VERSIONS = 10

// Client helper served from each pocket (public/pocket-oauth.js) that drives
// the shared OAuth relay. It starts the flow (redirect to the provider via the
// agent's one shared callback) and finishes it when bounced back — so the site
// author only calls `pocketLogin("google")`. __POCKET_NAME__/__POCKET_API_BASE__
// are substituted per pocket at deploy time.
const OAUTH_HELPER_TEMPLATE = `;(function () {
  var POCKET = "__POCKET_NAME__";
  var API_BASE = "__POCKET_API_BASE__";
  var RELAY = API_BASE + "/pocket/oauth/callback";
  var KEY = "__pocket_oauth_pkce";
  function b64url(o){return btoa(JSON.stringify(o)).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");}
  function pb(){ if(typeof PocketBase==="undefined") throw new Error("PocketBase SDK not loaded"); return new PocketBase(window.location.origin); }

  // Start login: redirect to the provider via the shared agent relay.
  window.pocketLogin = async function(provider, collection){
    provider = provider || "google"; collection = collection || "users";
    var methods = await pb().collection(collection).listAuthMethods();
    var providers = (methods.oauth2 && methods.oauth2.providers) || methods.authProviders || [];
    var p = providers.filter(function(x){return x.name===provider;})[0];
    if(!p) throw new Error("Provider '"+provider+"' is not enabled on this pocket");
    var nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    var state = b64url({ p: POCKET, n: nonce });
    sessionStorage.setItem(KEY, JSON.stringify({ state: state, codeVerifier: p.codeVerifier, provider: provider, collection: collection }));
    var auth = new URL(p.authURL || p.authUrl);
    auth.searchParams.set("redirect_uri", RELAY);
    auth.searchParams.set("state", state);
    window.location.href = auth.toString();
  };

  // Finish login if the relay bounced us back with ?__pocket_oauth=1.
  async function finish(){
    var params = new URLSearchParams(window.location.search);
    if(params.get("__pocket_oauth")!=="1") return;
    var saved=null; try{ saved=JSON.parse(sessionStorage.getItem(KEY)||"null"); }catch(e){}
    sessionStorage.removeItem(KEY);
    var clean = window.location.pathname;
    try{
      if(params.get("error")) throw new Error(params.get("error"));
      if(!saved || params.get("state")!==saved.state) throw new Error("OAuth state mismatch");
      var code = params.get("code"); if(!code) throw new Error("No authorization code");
      await pb().collection(saved.collection).authWithOAuth2Code(saved.provider, code, saved.codeVerifier, RELAY);
      window.history.replaceState({}, "", clean);
      if(typeof window.onPocketLogin==="function") window.onPocketLogin(); else window.location.reload();
    }catch(e){
      window.history.replaceState({}, "", clean);
      if(typeof window.onPocketLoginError==="function") window.onPocketLoginError(e); else console.error("[pocket-oauth]", e);
    }
  }
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", finish); else finish();
})();
`

export class PocketStorage {
  private metaDir: string
  private codeDir: string
  private dataDir: string
  private historyDir: string

  constructor(dataDir: string) {
    this.metaDir = join(dataDir, "pockets")
    this.codeDir = join(dataDir, "pocket-code")
    this.dataDir = join(dataDir, "pocket-data")
    this.historyDir = join(dataDir, "pocket-history")
    for (const d of [this.metaDir, this.codeDir, this.dataDir, this.historyDir]) {
      if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o755 })
    }
  }

  private validateName(name: string): void {
    if (!name) throw new ValidationError("Pocket name cannot be empty")
    if (!/^[a-z0-9-]+$/.test(name)) {
      throw new ValidationError("Pocket name must contain only lowercase letters, numbers, and hyphens")
    }
    if (name === "api") throw new ValidationError("'api' is a reserved name")
  }

  private metaPath(name: string): string { return join(this.metaDir, `${name}.json`) }
  getCodePath(name: string): string { return join(this.codeDir, name) }
  getDataPath(name: string): string { return join(this.dataDir, name) }
  private historyPath(name: string): string { return join(this.historyDir, name) }

  create(data: Omit<Pocket, "createdAt" | "updatedAt">): Pocket {
    this.validateName(data.name)
    if (this.exists(data.name)) throw new ValidationError(`Pocket '${data.name}' already exists`)
    const now = new Date().toISOString()
    const pocket: Pocket = { ...data, createdAt: now, updatedAt: now }
    writeFileSync(this.metaPath(pocket.name), JSON.stringify(pocket, null, 2))
    return pocket
  }

  get(name: string): Pocket | null {
    const p = this.metaPath(name)
    if (!existsSync(p)) return null
    try { return JSON.parse(readFileSync(p, "utf-8")) as Pocket } catch { return null }
  }

  update(name: string, updates: Partial<Omit<Pocket, "name" | "createdAt">>): Pocket | null {
    const pocket = this.get(name)
    if (!pocket) return null
    const updated: Pocket = {
      ...pocket, ...updates,
      name: pocket.name, createdAt: pocket.createdAt, updatedAt: new Date().toISOString(),
    }
    writeFileSync(this.metaPath(name), JSON.stringify(updated, null, 2))
    return updated
  }

  exists(name: string): boolean { return existsSync(this.metaPath(name)) }

  list(): Pocket[] {
    if (!existsSync(this.metaDir)) return []
    return readdirSync(this.metaDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.metaDir, f), "utf-8")) as Pocket)
      .sort((a, b) => (b.deployedAt || "").localeCompare(a.deployedAt || ""))
  }

  delete(name: string): boolean {
    let deleted = false
    for (const p of [this.metaPath(name), this.getCodePath(name), this.getDataPath(name), this.historyPath(name)]) {
      if (existsSync(p)) { rmSync(p, { recursive: true }); deleted = true }
    }
    return deleted
  }

  private nextVersion(name: string): number {
    const h = this.historyPath(name)
    if (!existsSync(h)) return 1
    const versions = readdirSync(h)
      .filter((f) => f.startsWith("v") && !f.endsWith(".json"))
      .map((f) => parseInt(f.slice(1), 10))
      .filter((n) => !isNaN(n))
    return versions.length > 0 ? Math.max(...versions) + 1 : 1
  }

  private archiveCode(name: string): void {
    const codePath = this.getCodePath(name)
    if (!existsSync(codePath)) return
    const h = this.historyPath(name)
    if (!existsSync(h)) mkdirSync(h, { recursive: true })
    const version = this.nextVersion(name)
    cpSync(codePath, join(h, `v${version}`), { recursive: true })
    // Prune
    const versions = readdirSync(h)
      .filter((f) => f.startsWith("v") && !f.endsWith(".json"))
      .map((f) => parseInt(f.slice(1), 10)).filter((n) => !isNaN(n)).sort((a, b) => a - b)
    while (versions.length > MAX_HISTORY_VERSIONS) {
      const old = versions.shift()!
      const p = join(h, `v${old}`)
      if (existsSync(p)) rmSync(p, { recursive: true })
    }
  }

  // Extract an uploaded code zip (public/**, pb_migrations/**, pb_hooks/**) to
  // the read-only mount source. NEVER touches the pb_data volume.
  async extractCode(name: string, zipData: Uint8Array): Promise<{ size: number; version: number }> {
    const codePath = this.getCodePath(name)
    if (existsSync(codePath)) {
      this.archiveCode(name)
      rmSync(codePath, { recursive: true })
    }
    mkdirSync(codePath, { recursive: true, mode: 0o755 })

    let size = 0
    const unzipped = unzipSync(zipData)
    for (const [filename, data] of Object.entries(unzipped)) {
      if (filename.endsWith("/")) continue
      const filePath = join(codePath, filename)
      const resolved = resolve(filePath)
      if (resolved !== resolve(codePath) && !resolved.startsWith(resolve(codePath) + sep)) {
        throw new ValidationError(`Unsafe path in upload: ${filename}`)
      }
      mkdirSync(join(filePath, ".."), { recursive: true, mode: 0o755 })
      await Bun.write(filePath, data, { mode: 0o644 })
      size += data.length
    }
    // Ensure PocketBase's expected subdirs exist even if the upload omitted them.
    for (const sub of ["public", "pb_migrations", "pb_hooks"]) {
      const p = join(codePath, sub)
      if (!existsSync(p)) mkdirSync(p, { recursive: true, mode: 0o755 })
    }

    const version = this.nextVersion(name)
    return { size, version }
  }

  // Inject a system hook that enables Google OAuth2 from env vars when both are
  // present. Written into the mounted pb_hooks dir so PocketBase loads it.
  // PocketBase 0.23 configures OAuth2 providers on the auth collection (not
  // global settings); applied on every boot so credential changes take effect
  // on redeploy. Verified against the pinned 0.23.4 binary.
  writeGoogleHook(name: string): void {
    const hook = `onBootstrap((e) => {
  e.next()
  const id = $os.getenv("POCKET_GOOGLE_CLIENT_ID")
  const secret = $os.getenv("POCKET_GOOGLE_CLIENT_SECRET")
  if (!id || !secret) return
  const users = e.app.findCollectionByNameOrId("users")
  users.oauth2.enabled = true
  users.oauth2.providers = [{ name: "google", clientId: id, clientSecret: secret }]
  e.app.save(users)
})
`
    const dir = join(this.getCodePath(name), "pb_hooks")
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o755 })
    writeFileSync(join(dir, "_siteio_google.pb.js"), hook, { mode: 0o644 })
  }

  // Write the client OAuth helper into the pocket's public dir so the frontend
  // can `<script src="/pocket-oauth.js">` and call `pocketLogin("google")`.
  // The shared relay lives on the agent's api host; the pocket name is baked in
  // so state routes back correctly.
  writeOAuthHelper(name: string, baseDomain: string): void {
    const js = OAUTH_HELPER_TEMPLATE
      .replace(/__POCKET_NAME__/g, name)
      .replace(/__POCKET_API_BASE__/g, `https://api.${baseDomain}`)
    const dir = join(this.getCodePath(name), "public")
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o755 })
    writeFileSync(join(dir, "pocket-oauth.js"), js, { mode: 0o644 })
  }

  toInfo(pocket: Pocket, domain: string): PocketInfo {
    const primary = pocket.domains[0] || `${pocket.name}.${domain}`
    return {
      name: pocket.name,
      url: `https://${primary}`,
      adminUrl: `https://${primary}/_/`,
      domains: pocket.domains,
      status: pocket.status,
      pocketbaseVersion: pocket.pocketbaseVersion,
      size: pocket.size,
      version: pocket.version,
      deployedAt: pocket.deployedAt,
      createdAt: pocket.createdAt,
    }
  }
}
