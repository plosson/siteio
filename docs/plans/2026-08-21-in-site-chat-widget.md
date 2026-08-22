# In-site chat widget — live editor overlay

**Status:** Plan v2 — review-incorporated (3-agent security/architecture/UX review folded in), **phased**
**Date:** 2026-08-21 (rev. 2026-08-22)
**Builds on:** `docs/plans/2026-08-20-site-chat-ai-editor.md` (AI site-chat editor, shipped v1.33.0)
**Scope:** An owner opens a site via a special one-time link and gets an Intercom-style chat
bubble **on the site itself**; they edit by chatting and watch changes land in place. The link
is ultimately meant to be handed to a client — but that hand-off is **phased behind hard
security prerequisites** (see §2).

---

## 1. What the user wants
- A little chat widget (like Intercom) that appears **on the deployed site**, not the admin panel.
- Opened by loading the site with a **special one-time key**.
- Edits made through it deploy and are **visible immediately** on the page you're looking at.
- Eventually: hand that link to a **client/designer** so they can self-serve edits.

## 2. Approach & phasing (the headline decision from review)

The security review established that **handing the link to a non-owner is unsafe on the current
sandbox**: the sandbox still runs with unlocked egress and the operator's *global* Claude token
inside the container (`sandbox-executor.ts:52-59,86-102`), and there is no per-session spend cap.
An untrusted person at the prompt can simply exfiltrate the token (`"run env; curl it to evil"`)
or loop turns to exhaust the shared credential. So the feature ships in phases:

- **Phase 0 — prerequisites (in the *base* feature, not this one):** an **egress proxy +
  token-out-of-container** (base plan §8) and a **per-grant spend cap**. Client hand-off is
  blocked until these exist.
- **Phase 1 — owner-only live editor (build now):** identical mechanism and UX, but the only
  person who can open a link is the **owner** (who already holds god access, so it introduces no
  new exfiltration/cost surface). This proves the whole path — shell, sandboxed iframe, cookie
  session, scoped chat, instant reload — safely.
- **Phase 2 — client hand-off:** unlock non-owner links **only after Phase 0**, adding the
  visible spend/time budget, differentiated link states, and mobile behavior.

Everything below is built in Phase 1 unless marked **[P2]**.

## 3. Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Where the widget runs | Agent-served **editor shell** at `https://<site>.<domain>/_siteio/edit` that frames the live site + overlays the bubble. Not injected into the real page (see §5). |
| 2 | Framed iframe | **Sandboxed, opaque-origin** iframe (`sandbox="allow-scripts allow-forms allow-popups"`, **no `allow-same-origin`**) so the edited page's JS cannot reach the shell's credential. Reload via **`iframe.src` reset**; page context via **`postMessage`**. |
| 3 | Session credential | **`HttpOnly` cookie scoped to `/_siteio`** (not a `sessionStorage` bearer). Single-*active-session* re-establishable within the code's TTL so a closed tab isn't a dead end. |
| 4 | One-time code | Single-use **edit code** (grant `kind:"edit"`, `expiresAt` +30 min) carried in the URL **fragment**; exchanged **on an explicit "Start editing" gesture** (not auto, so chat-app unfurlers can't consume it) for the cookie session. |
| 5 | Auth substrate | Reuse **share-grants** (`GrantStore`) + the `/_siteio` scoped channel; add a `kind` field. Chat routes are gated to `kind:"edit"` so existing share links are unaffected. |
| 6 | Edit scope | **Content-only** — `createEdit` forces `allowBackend:false`; same sandbox execution; `DELETE /chat` (clear history) is **not** exposed to the session. |
| 7 | Who mints / uses | God key mints. **Phase 1: owner-only.** **[P2]** hand to a client after Phase 0. |
| 8 | Framed host | Frame the **platform subdomain** `${name}.${domain}` (never the custom/CF-fronted domain) so edge cache can't hide fresh deploys — the mint must hard-code this. |
| 9 | Spend cap | A **per-grant turn/deploy cap**, enforced server-side. Mandatory (blocking for [P2]; good hygiene in P1). |

## 4. What already exists (verified — the recombination thesis)

Architecture review confirmed the load-bearing claims against the code:
- **The agent owns `<site>.<domain>/_siteio/*`.** Traefik's `mcp-router` siphons
  `PathPrefix(/_siteio)` (+ `/mcp`, oauth well-knowns) to the agent, host-agnostic, at
  `priority:1000` over the site's own router (`traefik.ts:137-149`).
- **Unauth carve-outs have a clean precedent.** The `/_siteio` branch resolves the site from the
  host, then carves out `GET /_siteio/health` **before** `authenticate()` (`server.ts:194-211`).
  Two more exact-match pre-auth clauses (`/edit`, `/edit/session`) mirror this.
- **`ChatController` is already god/grant-agnostic** — `runTurn({siteName,userMessage,onEvent})`
  (`controller.ts:102-106`), deploy always via `deps.deploy`→`deploySiteViaGrant`, per-site lock
  (`controller.ts:122`). **No controller changes needed.**
- **SSE plumbing already survives the site host** — `idleTimeout:255` + 15s heartbeats already
  exist; no-change skip, cache middleware (`server.ts:1507-1510`), version-before capture, and
  `deployedBy` attribution (`server.ts:1265,1311`) are all present.
- **Assets compile into the binary** via `with { type: "text" }` (`assets.ts:1-3`); no workflow
  change, no build step.
- **Deny-by-default scoping is real** (`server.ts:1339-1359`): a grant cannot reach other sites,
  `/agent`, `/sites/:name/admin`, delete/rename/rollback, other grants, apps, or the god key —
  all fall through to `notAllowed()`. `pb_data` is untouched; symlink exfiltration is already
  closed (`workspace.ts` `lstat`/skip-symlink).

### New pieces to build
Edit-grant variant (`kind`/`expiresAt`/`consumedAt` + TTL/single-use); `siteio sites edit`;
two unauth `/_siteio` carve-outs (shell + exchange); `kind`-gated scoped chat routes; the shell
(sandboxed iframe + cookie session + postMessage + readiness-poll reload); an **extracted,
framework-agnostic chat module** shared by the admin panel and the widget; grant indexing +
eager gc + list-filtering; the per-grant spend cap.

## 5. Architecture (Phase 1)

```
Owner: `siteio sites edit srilanka`            (god key, api host)
  └─▶ POST /sites/srilanka/edit-link → mints edit code (grant kind:"edit", +30m, single-use)
      prints  https://srilanka.<domain>/_siteio/edit#<code>     (platform subdomain, §3.8)

Browser opens URL → Traefik → agent /_siteio branch:
  GET  /_siteio/edit            → shell HTML (UNAUTH, inert; exact-match carve-out)
       shell reads #code (history.replaceState to strip it), shows "Start editing"
  POST /_siteio/edit/session    → [on gesture] validate+consume code (sync), set HttpOnly
       {code}                     cookie (Path=/_siteio, SameSite=Strict), return {siteUrl,...}
  ┌ <iframe sandbox="allow-scripts allow-forms allow-popups"  src=https://srilanka.<domain>/ >
  │     (opaque origin: cannot read the shell cookie or make credentialed calls)
  │     ── postMessage ──▶ shell: current path, so the turn edits the RIGHT page
  └ bubble → POST /_siteio/sites/srilanka/chat   (SSE; auth = cookie; gated kind:"edit")
             → handleScopedRequest → ChatController → SandboxChatExecutor → deploy
             on {done,deployed}: readiness-poll site (fetch until 200) → reset iframe.src
                                 (overlay "Applying your change…", restore scroll)
```

### Why the shell/iframe split
The site is served straight from its PocketBase container (Traefik → container, **not** through
the agent), so the agent can't inject a `<script>` into the real HTML without proxying. The
shell gives the same UX with **zero site changes**. And the iframe is **sandboxed without
`allow-same-origin`** so the (attacker-controllable) site content runs in an opaque origin and
cannot reach the shell's credential — resolving the review's central tension (same-origin reload
convenience vs. credential theft). Reload/context therefore use `src` reset + `postMessage`
instead of `contentWindow.location`.

## 6. Auth & session model (the sensitive surface)

- **Edit code** — grant `kind:"edit"`, `expiresAt` (+30 min), `singleUse:true`; `createEdit`
  forces `allowBackend:false` (the session token also carries the raw zip-deploy route
  `handleScopedDeploy`, which honors `allowBackend`, `server.ts:1385`). God-mint only; verify
  `chatController` is configured at mint time (else the link dead-ends at "Chat is not
  configured").
- **Fragment + gesture** — the code rides the URL fragment (server-invisible). The shell requires
  an explicit **"Start editing"** click before exchanging, so link-preview bots (Slack/iMessage/
  Teams execute JS) can't silently consume a single-use code. (The fragment is still only as
  private as the delivery channel — don't oversell it.)
- **Exchange → cookie** — `POST /_siteio/edit/session` does `resolveByToken → check
  expiry+consumedAt → write consumedAt` with **no `await` between the check and the write**
  (parse the body first) so two concurrent exchanges can't both mint. On success it sets an
  **`HttpOnly`, `SameSite=Strict` cookie** on `Path=/_siteio` carrying a **derived session
  grant** (own `expiresAt`, `kind:"edit-session"`, `allowBackend:false`) and returns the framed
  `siteUrl`. `authenticate()` gains: accept this cookie on the `/_siteio` scoped channel (in
  addition to `X-API-Key`).
- **Live TTL** — `resolveByToken` must itself reject `expiresAt < now` (don't rely on the
  startup-only `gc`, `grant-store.ts:74-84,112-119`).
- **Single active session, re-establishable** — the code is single-*use-to-mint* but within its
  30-min TTL the shell can re-exchange to recover a lost cookie (closed tab), avoiding the
  dead-end; superseded/older session grants are revoked on re-exchange.
- **Revoke cascade** — link the derived session to its parent code; `sites edit --revoke`
  revokes both. (Without this, "easy revoke" is false — the owner never sees the derived id.)
- **Scoped surface** — chat routes added to `handleScopedRequest` are **gated to `kind` in
  {edit, edit-session}** so existing content-deploy share links are unaffected; keep the
  per-route `!== grant.site` guard (`server.ts:1345,1353`); **do not** expose `DELETE /chat`.
- **Hygiene** — index grants by token hash (today `resolveByToken` reads every grant file per
  request, `grant-store.ts:74-80`); **gc expired/consumed eagerly**; **filter** `kind:"edit"`/
  `edit-session` grants out of `handleListGrants` so they don't clutter the admin share-links UI.
- **Spend cap** — track turns/deploys on the grant; refuse past the cap with a clear message.
- **Shell anti-clickjack** — serve `/_siteio/edit` with `frame-ancestors 'none'`.

## 7. Immediate-update mechanism

- On `done`+`deployed`: show an **"Applying your change…"** overlay, **readiness-poll** the site
  (`fetch(siteUrl,{cache:'no-store'})` until 200 — the container recreate leaves a ~1s Traefik
  **502 document** window, `server.ts:1500`), then reset `iframe.src`, then hide the overlay on
  `load`. Blind reload-and-retry won't reliably fire for an HTTP-200 error page.
- Frame the **platform subdomain** so `Cache-Control:no-cache` (`server.ts:1507-1510`) applies and
  CF edge cache can't serve stale bytes.
- **Preserve iframe scroll** across the reset (ask the framed page for scrollY via postMessage
  before, restore after) — this is the core "it changed right where I was looking" effect, not a
  nice-to-have.
- **Page context**: the shell asks the framed page (postMessage) for its current path and passes
  it into the turn, so "make this headline bigger" edits the page the user is actually viewing.

## 8. Client-grade UX (built in Phase 1 so the Phase 2 hand-off works)

Even owner-only, build the shell for the eventual non-technical client:
- **Terminal states, not the admin login.** On 401/expiry/cap the shell shows a client
  message ("Your editing session ended — ask for a new link"); it must **not** reuse the admin's
  `siteio:unauthenticated`→login flow (`ui.js:185-189`).
- **Differentiated link states**: expired vs. already-used vs. revoked vs. connecting vs.
  exchange-failed — each with the same clear next step.
- **First-open welcome** (one-time acknowledged): which site, that **changes go live to real
  visitors immediately**, and that per-change undo exists — stronger than the admin's passive
  disclosure (`index.html:616`).
- **Attribution**: `sites edit --label "<who>"` → threaded into `deployedBy` so History shows
  "changed by <client> via edit link" (owner recovery/trust).
- **Undo**: keep per-turn revert, reworded to "**Undo this change**" (no version jargon), **plus**
  record `versionAtStart` on the grant to offer "**Restore to how it was when I started**".
- **Affordance triage** (vs. the reused admin chat): **drop** Clear-history (audit trail);
  **hide** model/provider + "sandboxed" jargon (`index.html:594-597`); **drop** the redundant
  "View live" link; keep streamed tool chips but lead the turn-complete card with "**your change
  is live**", files behind a details toggle.
- **[P2] Visible session budget** (time left / edits left) — mandatory once a client spends the
  owner's credential; a silent 403 is the worst outcome.
- **Mobile behavior** must be stated: an expanded bubble covers a phone viewport (you can't see
  the site you're editing) → collapse-to-see, or gate to "best on desktop". **[P2]** to finalize.
- **Bubble**: Intercom-style docked/collapsible; note it edits **production with no preview**
  (base feature chose pure auto-deploy; owner recovery via attribution + whole-session undo is
  the compensating control).

## 9. Security posture & residual risk

- **Boundary preserved**: deny-by-default scoped surface (§4), content-only (`workspace.ts:65`
  + `allowBackend:false`), `pb_data` untouched, symlink exfiltration closed, per-site double
  scoping (host `ctx.site` + per-route `!== grant.site`).
- **Credential isolation (B1 fix)**: sandboxed opaque-origin iframe + `HttpOnly` cookie → edited
  content can't read or ambiently use the session credential. Verify with a test that deploys a
  `<script>` trying to read the parent credential and asserts it gets nothing.
- **Existing share links untouched (B2 fix)**: chat gated to edit-kind grants.
- **Residual, gates Phase 2 (B3/B4)**: the sandbox still holds the operator's global token with
  unlocked egress and (until §9 P0) unbounded per-session cost. **This is why Phase 1 is
  owner-only** and Phase 2 waits on the base-feature egress proxy + token-out-of-container + the
  visible cap.

## 10. Build order (phased, each step independently testable)

**Phase 0 (base feature, prerequisite for P2):** egress proxy + token-out-of-container; per-grant
spend cap primitive. *(Tracked in base plan §8; not built here.)*

**Phase 1 (this plan):**
1. **Grant model**: `kind`/`expiresAt`/`consumedAt`; `createEdit(site,ttl)`, sync `consume(id)`,
   live-TTL reject in `resolveByToken`, eager gc, token-hash index, list-filter. *Unit:* expired/
   consumed don't resolve; concurrent consume mints once; edit grants absent from `listForSite`.
2. **`sites edit` + `POST /sites/:name/edit-link`** (god-only; hard-codes platform subdomain;
   checks `chatController`; `--label`, `--revoke`, `--open`). *API test:* well-formed URL + code
   resolves; custom-domain site still yields a platform-subdomain link.
3. **Unauth carve-outs** in `/_siteio` (exact-match `GET /edit`, `POST /edit/session`), cookie
   exchange, `authenticate()` cookie acceptance, anti-clickjack header. *Test:* shell served
   unauth; gesture-gated exchange consumes once + sets cookie; second exchange fails.
4. **Scoped chat routes** (`GET/POST/stop`, no clear-history) gated to edit-kind; reuse
   `handleSiteChat` after a `name===grant.site` check. *e2e (fake executor + edit grant):* scoped
   turn deploys a new version; a plain share grant gets 403 on chat; a normal share deploy still
   works.
5. **Extract shared chat module** from `ui.js` (SSE reader, tool chips, deploy/revert) consumed by
   both admin panel and widget. *Test:* admin chat still green (existing Playwright specs).
6. **Editor shell UI**: sandboxed iframe, "Start editing" gesture, cookie session, postMessage
   page-context + scroll, readiness-poll reload + overlay, terminal/link states, welcome,
   reworded undo, affordance triage. *Playwright (local agent, fake executor):* open `…#code` →
   Start → send → streamed steps → iframe reloads to the change → undo → expired/used states.
7. **Admin entry point**: "Open live editor" button on the site detail page.
8. **Poll-first resync on the site host** (SSE as enhancement; verify whether `*.<domain>` is
   CF-proxied and could hit the edge timeout). **Docs + release.**

**Phase 2:** enable non-owner links, visible budget countdown, mobile finalization — after Phase 0.

## 11. Testing & local verification (acceptance principle)

Same bar as the base feature (§10 there): **verifiable locally end-to-end, no mocks as the
acceptance gate.**
- Real loop: `bun run dev` + real `CLAUDE_CODE_OAUTH_TOKEN` + sandbox image → `siteio sites edit
  <local-site>` → open the `…/_siteio/edit#…` URL → **Start editing** → real prompt → agent edits
  in the sandbox → deploy lands → **iframe reloads to show the change in place** → undo restores →
  the consumed link no longer opens; a fresh tab within TTL re-establishes the session.
- Fake-executor/CI layers (no token): grant TTL/consume race, live-expiry, revoke cascade,
  kind-gating (existing share links can't chat), platform-subdomain mint, exact-match carve-outs,
  cookie exchange, **sandboxed-iframe token isolation** (deployed `<script>` can't read the
  parent credential), unfurler-safe gesture, readiness-poll reload.
- Screenshot the shell steps (welcome, streaming, applying-overlay, deployed-in-place, undo) as
  proof, the way the base feature was verified on sitedebile.fr.

## 12. Review provenance

Consolidated from three independent reviews (2026-08-22): **architecture** (no blockers; confirmed
the recombination thesis and resized the widget-extraction, platform-subdomain-mint, and reload-
readiness work), **security** (4 blockers — B1 same-origin bearer theft, B2 scoped-channel
upgrade of all grants, B3 token exfiltration via unlocked egress, B4 no spend cap — all reflected
in the locked decisions and phasing), **product/UX** (client-as-primary-user gaps: mid-session
dead-end, closed-tab trap, missing page context, invisible budget — folded into §8). The pre-
review draft's sessionStorage-bearer and unconditional client hand-off were reversed accordingly.
