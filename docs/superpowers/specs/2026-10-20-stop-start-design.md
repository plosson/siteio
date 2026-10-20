# Stop / start for sites and apps — design

Date: 2026-10-20

## Goal

Take a site or an app offline for a while (a client stopped paying, a seasonal
site) and bring it back exactly as it was with one command.

- While stopped, every URL of the item answers **404** (no placeholder page).
- Code, `pb_data`, history, env, secrets, domains and the `<name>.<domain>`
  subdomain are kept.
- Nothing brings it back online by accident: not a deploy, a share link, chat,
  auto-deploy, a config change or a server reboot. Only `start` does.

## Model

One concept, `stop`, for sites and apps. It reuses the existing
`status: "stopped"` (`ContainerStatus` in `src/types.ts`); no new field.

The agent's **stored** status is the gate, not Docker's live state. Stopping
**removes** the containers (volumes and data are kept), so:

- nothing can restart them (restart policy `always`, compose `restart:`
  policies and Docker daemon restarts no longer matter);
- the existing "no container" paths already leave the item offline:
  `restartSiteContainer` does nothing without a container, and `rename` skips
  the restart when there was none. So `domain add/remove`, `set/unset` and
  `rename` on a stopped site change the stored config only.

Today nothing sets a site to `stopped`, and only the app stop handler sets an
app to `stopped` (`server.ts` `handleStopApp`). So `stopped` always means
"stopped on purpose".

## Commands

| Command | Effect |
|---|---|
| `siteio sites stop [name]` | New. Removes the PocketBase container, sets `stopped`. |
| `siteio sites start [name]` | New. Creates the container from the current stored config (`startSiteContainer`), sets `running`. |
| `siteio apps stop [name]` | Changed: removes the containers (`docker rm`, or `compose down` **without** `-v`; the existing down call passes `-v` and deletes volumes) instead of stopping them. |
| `siteio apps start [name]` | New. Creates the containers again from the stored config and the image already on the server, without a build or pull. When no image is left (pruned), falls back to a full deploy, since `deploy` itself is refused while stopped. |
| `siteio apps restart [name]` | Changed: on a running app, as today. On a stopped app, does the same as `apps start` (same function). |

`[name]` defaults to `.siteio/config.json`, like the other commands. Output
follows the dual-output pattern: JSON on stdout, readable text on stderr.

`start` on an item that is not stopped returns an error ("not stopped").
`stop` on an item that is already stopped returns an error ("already stopped").

## Refused while stopped

These return **409** with `"<site|app> '<name>' is stopped; run 'siteio <sites|apps> start <name>' first"`:

- Sites: deploy (CLI, MCP, share and edit links, chat), rollback, upgrade.
- Apps: deploy.
- Chat: a new chat turn on a stopped site is refused **before** the LLM is
  called.
- `siteio sites upgrade --all` skips stopped sites and lists them as skipped.
- Auto-deploy already skips stopped apps (`auto-deploy.ts`); no change.

**The gate runs before any `try/catch` that writes `status: "failed"`**: at the
start of `runSiteDeploy`, `runRollback`, `handleUpgradeSite` (before the pull
and the container removal), `handleDeployApp` and `handleSiteChat`. Otherwise the error handler overwrites `stopped` with
`failed` and the marker is lost.

## Allowed while stopped (the item stays offline)

- Sites: `domain add/remove`, `set/unset`, `rename`. Changes take effect on
  `start`.
- Apps: `apps set`. Changes take effect on `start`, because `start` creates
  the containers again.
- Both: `info`, `list`, `logs` (of the last run, if Docker still has them; may
  be empty), `history`, `download`, `rm`, share link `list` and `revoke`.

`list` and the admin UI show stopped items with their status. They are not
hidden.

## The agent's own routes on the site's hostname

Traefik's `mcp-router` matches `/_siteio/*`, `/mcp` and `/.well-known/oauth-*`
on every host, whatever the container's state (`traefik.ts`). The agent
finds the site through `oauthProvider.hostContext(host)`.

When the site behind a host is stopped, these routes answer **404**. This
covers the in-site editor (`/_siteio/edit`), `/_siteio/health`, MCP and the
OAuth pages, so share and edit links stop working too.

## Permissions

Whoever may deploy an item may stop and start it:

- the god key, admins, the owner;
- tenants and members, for their own items: add `stop` and `start` to
  `TENANT_ROUTE` and `start` to `TENANT_APP_ROUTE` (`stop` is there already).

Share links and edit links may **not** stop or start.

A tenant can start an item an operator stopped. To cut off a client, remove
the tenant or revoke their keys.

## Side effects

- Stop and start page pagerio (when configured), like `restart` does today.
- No ranking post: stop and start are not deploys.
- Thumbnails and analytics are unchanged; neither starts containers.

## Admin UI

- Sites: Stop and Start buttons; the one shown depends on the status.
- Apps: a Start button next to the existing Stop and Restart. While stopped,
  Start is shown and Stop and Restart are hidden.

## Docs

- `CLAUDE.md` feature list.
- The agent guides in `src/lib/skill-content.ts` (sites and apps).

## Breaking changes

- `apps deploy` on a stopped app now fails; use `apps start` (or
  `apps restart`), then deploy. Apps already stopped on the production servers are affected.
  Say so in the release notes.
- `apps stop` now removes the containers. Data in named volumes and bind
  mounts is kept; anonymous volumes (an image's own `VOLUME`, e.g. `postgres`
  run without `-v`) are not reattached, and data written only to the
  container's own filesystem is lost (as on every deploy today).
- Check whether the Mac app (plosson/siteio-app) calls `deploy` on stopped
  apps.

## Tests (adversarial)

- On a stopped site, deploy, rollback, upgrade, chat and share-link MCP deploys
  each return 409, and the stored status stays `stopped` (not `failed`).
- `domain add`, `set` and `rename` on a stopped site leave it with no container
  and status `stopped`.
- `/_siteio/edit`, `/_siteio/health` and `/mcp` on a stopped site's host
  return 404.
- `start` brings back the domains and env changed while stopped.
- `stop` twice and `start` twice return errors and do not change state.
- `apps start` on an app that was never deployed fails cleanly with status
  unchanged.
- `apps deploy` on a stopped app returns 409 and the status stays `stopped`.
- `apps restart` on a stopped app starts it with the same image (no build or
  pull) and applies settings changed while stopped.
- A share grant cannot call stop or start; a tenant cannot stop or start
  another tenant's item.
- `upgrade --all` skips a stopped site and leaves it stopped.

## Out of scope

- Hiding stopped items from `list`.
- A `stoppedBy` field, or operator-only stops.
- A placeholder page for stopped items.
