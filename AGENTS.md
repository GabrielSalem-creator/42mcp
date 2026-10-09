# 42MCP — Website → MCP platform on a Boxd VM

Turn any website into an always-on MCP server + REST API. A user names a site, signs
in once on a private cloud browser, and gets MCP/REST endpoints (under `42mcp.tech`)
that read and act on that site. One active connection at a time; a new site replaces it.

## Architecture (what is true now)

- **VM:** `sitemcp-core` on Boxd — 4 vCPU / 16 GB, Ubuntu 24.04. Persistent Chrome via
  `agent-browser` on display `:100` (desktop = `boxd-desktop.service`).
- **App:** Express + WS server (`src/server.js`) + per-connection MCP over Streamable HTTP
  (`src/mcpHttp.js`). Runs either on your PC (drives the VM over the Boxd API) or ON the
  VM (`VM_LOCAL=1`, shell runs locally) to serve `42mcp.tech`.
- **Site agent:** `src/siteAgent.js` — login detection + a bounded Artbloom-planned
  `agent-browser` action loop that returns JSON and caches workflows.
- **Connections:** `src/connectionStore.js` — single active connection, generated tools,
  workflow cache, per-connection API key.
- **Domain:** `42mcp.tech` (A `@`→`109.94.96.51`, CNAME `*`→`sitemcp-core.boxd.sh`), bound on Boxd.

## Key commands

- `npm start` — run the control app on your PC (http://localhost:3000).
- `npm run go-live` — start the always-on service on the VM so `42mcp.tech` serves it.
- `npm run deploy` — upload code + install + start service on the VM.
- `npm run probe` / `npm run vm "<cmd>"` — inspect / run a shell command on the VM.
- `npm run resize 4 16G` — change VM size. `npm run domain` — DNS records.

## MCP server (for Cursor / agy / Claude clients)

`.cursor/mcp.json` registers `boxd-vps` → `src/mcp/server.js`. Primary tool: **`vm_do`**
(run the user's request on the VM). Per-connection remote MCP: `https://42mcp.tech/mcp/<id>`
with `Authorization: Bearer <apiKey>`.

## Scope / safety

Login only — never create accounts, never store passwords, operate only the owner's own
session. Write actions are flagged and need explicit approval.
