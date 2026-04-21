# Bun TUI evaluation for a siteio admin TUI

**Date:** 2026-04-21
**Status:** Research notes — no implementation decision yet
**Context:** The browser-based admin UI (`src/lib/agent/ui/`, shipped in v1.17.0) may be overkill for the primary operator workflow. A TUI distributed inside the existing single binary could cover the same read + lifecycle surface with lower friction. This document surveys the current (April 2026) Bun TUI ecosystem and calls out prior art directly comparable to what a `siteio admin` / `siteio tui` subcommand would look like.

All repos listed below were verified to have pushes on or after 2025-10-21 unless explicitly flagged.

## 1. Library landscape

| Library | Stars | Last updated | Bun-first? | Model |
|---|---|---|---|---|
| **[OpenTUI](https://github.com/anomalyco/opentui)** (`@opentui/core` + `@opentui/react` + `@opentui/solid`) | 10,475 | 2026-04-21 | **Yes** — `bun create tui` is the canonical entry point | Zig native core + TS bindings; React and Solid reconcilers |
| [Ink](https://github.com/vadimdemedes/ink) | 37,877 | 2026-04-21 | No (no Bun claim in README) | React + Yoga (incumbent in the Node ecosystem) |
| [Rezi](https://github.com/RtlZeroMemory/Rezi) | 613 | 2026-04-17 | Yes — "Node.js and Bun" | Declarative widgets on a C (Zireael) engine |
| [silvery](https://github.com/beorn/silvery) | 9 | 2026-04-21 | Yes — engines list Bun; Ink-7 drop-in (918/931 tests passing) | React + Flexbox ("Flexily"), pure TS |
| [Glyph](https://github.com/semos-labs/glyph) | 41 | 2026-04-16 | Yes — Bun quick-start first | React + Yoga, focus system |
| [bblessed](https://github.com/context-labs/bblessed) | — | — | Yes | Bun port of blessed (widget tree) |
| [pi-tui](https://github.com/badlogic/pi-mono) | 9 | 2026-04-20 | Bun-scripted | Imperative widgets, diff renderer, Kitty/iTerm2 image protocols |
| [@oakoliver/bubbletea](https://github.com/oakoliver/bubbletea) | 1 | 2026-04-19 | Yes — "Works on Node.js and Bun" | Elm architecture port (Model/Update/View) |
| [caibao](https://github.com/jjabez/caibao) | 1 | 2026-02-23 | Yes — "BubbleTea-inspired TUI framework for Bun" | Elm architecture, Bun-exclusive |
| [@unblessed/core](https://www.npmjs.com/package/@unblessed/core) | 9 | 2025-12-09 | Platform-agnostic (DI-based) | Modern TS rewrite of blessed |

### Supporting packages around OpenTUI

- [msmps/create-tui](https://github.com/msmps/create-tui) — 111 stars, 2026-04-21 — OpenTUI scaffolder (Bun workspace monorepo template)
- [msmps/opentui-ui](https://github.com/msmps/opentui-ui) — 140 stars, 2026-01-28 — shadcn-style component library for OpenTUI
- [msmps/opentui-examples](https://github.com/msmps/opentui-examples) — 17 stars, 2025-12-21

## 2. Prior art — applications close to a siteio admin TUI

Ten representative Bun + TUI apps updated since 2025-10-21, ordered by relevance:

| Repo | Stars | Stack | Why it matters |
|---|---|---|---|
| **[lazyvercel](https://github.com/nivalis-studio/lazyvercel)** | 3 | Bun ≥ 1.3 + OpenTUI + React 19 | **Closest direct analog.** Deploy-tool TUI for Vercel, distributed via `bunx lazyvercel`. Keyboard-driven dashboard, command palette, themes, live log drawer. Worth reading end-to-end before committing to a stack. |
| [tokentop](https://github.com/tokentopapp/tokentop) | 50 | Bun + OpenTUI / React-terminal | "htop for AI costs." Dense live-updating dashboard, sparklines, gauges, budget alerts. Reference for the monitoring-panel style. |
| [openpos](https://github.com/avalontm/openpos) | 205 | Bun + Ink + Zustand + Drizzle | Multi-screen POS TUI (login, inventory, forms). Reference for app-flow TUIs closer to "admin" than "monitor." |
| [waha-tui](https://github.com/muhammedaksam/waha-tui) | 320 | Bun + OpenTUI | WhatsApp TUI over the WAHA API — API-browsing pattern similar to siteio's remote agent. |
| [termcast](https://github.com/remorses/termcast) | 314 | Bun + OpenTUI + React | Runs Raycast extensions as TUIs. Strong command-palette reference. |
| [acolyte](https://github.com/cniska/acolyte) | 23 | Bun + TUI + visual regression (`test:tui`) | Mature Bun-native TUI — useful for test-infra patterns. |
| [relic](https://github.com/heycupola/relic) | 157 | Bun (+ Rust runner) | Encrypted secret manager that opens a TUI; CLI + TUI coexistence pattern relevant to siteio. |
| [termide](https://github.com/Nachx639/termide) | 8 | Bun + OpenTUI + React | Terminal-first IDE for AI agents. |
| [agent-coworker](https://github.com/mweinbach/agent-coworker) | 110 | Bun + OpenTUI | Long-running agent shell — another OpenTUI production usage. |
| [gh-term](https://github.com/aelhady03/gh-term) | 0 | Bun + Ink | GitHub issues/PRs TUI — remote-API browsing with Drizzle/Redis/Zod. |

### Honorable mentions / topic-filtered hits

- [oh-my-pi](https://github.com/can1357/oh-my-pi) — 3,282 stars, 2026-04-18 — AI coding agent with TUI, topics include `bun`, `terminal`, `tui`
- [relic](https://github.com/heycupola/relic) — 157 stars, 2026-04-14 — encrypted secrets manager TUI
- [terminal-farm](https://github.com/StringKe/terminal-farm) — 77 stars, 2026-03-28 — full-screen Ink-based automation TUI
- [glyph](https://github.com/semos-labs/glyph) — 41 stars, 2026-03-04 — also listed above as a library
- [betternmtui](https://github.com/anipr2002/betternmtui) — 9 stars, 2026-03-18 — NetworkManager TUI on OpenTUI + React

## 3. Ecosystem observations

1. **OpenTUI has consolidated the Bun-first TUI space** in the six months leading up to April 2026. It's used by OpenCode, terminal.shop, lazyvercel, waha-tui, termide, agent-coworker, termcast, and others. Every new Bun-advertised TUI project I looked at that was scaffolded in Q1 2026 used OpenTUI.
2. **Ink is still the safer bet for ecosystem maturity** (37k stars, bigger component/test surface, well-understood edge cases) but it does not advertise Bun support and the README is Node-oriented. It works on Bun in practice.
3. **Blessed and its forks are fading.** `chjj/blessed` is effectively unmaintained; `bblessed` (Bun-specific fork) exists but has minimal traction; `unblessed` is a promising rewrite in alpha but not Bun-specific.
4. **Bubbletea-style Elm-architecture ports** (`@oakoliver/bubbletea`, `caibao`, `cinderlink/cli-kit`) are emerging but all at <5 stars and pre-1.0 — risky for production today.
5. **No SST-hosted OpenTUI.** The `sst/opentui` URL now redirects to `anomalyco/opentui`. Some older blog posts still reference the SST namespace.

## 4. Recommendation

Build a `siteio admin` (or `siteio tui`) subcommand on **OpenTUI + `@opentui/react`**.

Reasons:

1. **Runtime match.** siteio is Bun-first and ships via `bun --compile`. OpenTUI is Bun-first. No Node compat shims, no ergonomic mismatch.
2. **Strongest prior art.** lazyvercel is the closest comparable project in the ecosystem — deploy-tool TUI, `bunx`-distributed, OpenTUI + React, command palette, live logs. That's essentially the target architecture.
3. **Reuse the existing design work.** The admin-ui spec (hash-based `#/apps`, `#/sites`, `#/groups` with lifecycle actions and log polling) translates almost 1:1 to a TUI: three panes selectable from a sidebar, detail view with sub-tabs, `apiFetch` wrapper unchanged.
4. **Single-binary friendly.** OpenTUI's prebuilt native binaries embed fine in a `bun --compile` output, same as Alpine/Tailwind strings do today.
5. **Native component library available.** `msmps/opentui-ui` provides tables, dialogs, toasts — saving the "reinvent widgets" phase.

Fallback option: **Ink** if OpenTUI's pre-1.0 status (0.1.102) is judged too risky. Accept the "Node-first README, works on Bun" positioning in exchange for maturity and a much larger community.

## 5. Non-recommendation

Do **not** retire `src/lib/agent/ui/` (the browser admin UI). It's already shipped in v1.17.0, covers the "remote operator without SSH access" case, and a TUI does not replace it. Both clients should talk to the same `AgentServer` JSON API. The TUI adds a second client; it is not a replacement plan.

## 6. Open questions before planning

- Does the TUI ship inside the existing `siteio` binary (new subcommand) or as a separate `siteio-tui` binary?
- Distribution: `bunx siteio-tui`, embedded subcommand, or both?
- Does the TUI also need to work against a *local* (non-agent) siteio installation, or only against a remote `api.<domain>`?
- Do we want feature parity with the browser admin UI at v1, or intentionally narrower (e.g., read + logs only in v1, lifecycle actions in v2)?
- Does the TUI need to work over SSH in dumb terminals, or can we assume a real TTY with truecolor + Unicode?

## Sources

- [OpenTUI site](https://opentui.com/) / [GitHub](https://github.com/anomalyco/opentui) / [npm @opentui/core](https://www.npmjs.com/package/@opentui/core)
- [Rezi](https://rezitui.dev/) / [GitHub](https://github.com/RtlZeroMemory/Rezi)
- [Ink](https://github.com/vadimdemedes/ink)
- [lazyvercel](https://github.com/nivalis-studio/lazyvercel) — closest prior art
- [Ink vs blessed comparison](https://npm-compare.com/blessed,ink)
- [From Browser to Terminal — Medium, 2026](https://thamizhelango.medium.com/from-browser-to-terminal-how-typescript-the-webs-darling-quietly-conquered-the-ai-agent-tui-d93a4eda62a5)
- [tui-library topic on GitHub](https://github.com/topics/tui-library)
- [rothgar/awesome-tuis](https://github.com/rothgar/awesome-tuis) (active, lists OpenTUI)
