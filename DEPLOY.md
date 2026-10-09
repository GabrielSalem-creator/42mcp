# 42MCP — run & go live

**Product:** name a website → sign in once on your private cloud browser → get an always-on MCP server + REST API for that site. One active connection at a time (a new site replaces the old one).

- **VM:** `sitemcp-core` on Boxd — 4 vCPU / 16 GB, Ubuntu 24.04, persistent Chrome via `agent-browser` on display `:100`.
- **Public domain:** `42mcp.tech` (A `@` → `109.94.96.51`, wildcard CNAME `*` → `sitemcp-core.boxd.sh`), bound on Boxd for TLS.
- **Planner brain:** an OpenAI-compatible LLM (Google Gemini API or open-source models) drives a bounded agent-browser action loop; local fallback for Instagram.

## Run locally (control from your PC — talks to the VM over the Boxd API)

```powershell
npm start            # http://localhost:3000  (new UI, drives the cloud VM)
```

## Make 42mcp.tech live (runs the app ON the VM)

The app is already uploaded to the VM at `/home/boxd/sitemcp` with deps installed and a VM-side `.env` (`VM_LOCAL=1`, `PUBLIC_BASE_URL=https://42mcp.tech`). Start the always-on service:

```powershell
npm run go-live       # installs a systemd service on the VM, port 3000, auto-restart
```

> If your harness blocks this as a "production deploy", run it yourself in the terminal
> (type `! npm run go-live` in this session, or run it in a normal shell). It needs no
> further input.

Boxd's default route auto-detects port 3000, so once the service is up:
`https://sitemcp-core.boxd.sh` and `https://42mcp.tech` serve the app.

Check it:

```powershell
npm run vm "systemctl is-active 42mcp.service; curl -s localhost:3000/api/status | head -c 120"
```

## Other commands

```powershell
npm run probe            # VM status + installed tooling
npm run deploy           # full: upload + npm install + start service
npm run deploy-prep      # upload + install only (no service)
npm run resize 4 16G     # (scripts/resize-vm.js) change VM size
npm run domain           # print DNS records for 42mcp.tech
npm run domain-bind      # bind 42mcp.tech on Boxd (after DNS is live)
```

## How a user uses it

1. Open the site, type a website in the chat ("instagram.com", a school portal, a CRM…).
2. A private browser opens on the VM. Click **Sign in** — a dynamic form shows the exact fields that site asks for (username/email/password, then a verification-code step if needed). Values go straight into your own browser session and are not stored. You can also sign in by hand on the live screen and tap **Verify session**.
3. Once connected you get an **MCP URL**, **REST endpoint**, and **API key** under `42mcp.tech`, plus a box to run natural-language instructions and save good ones as reusable tools.

- **MCP:** `POST https://42mcp.tech/mcp/<connectionId>` with `Authorization: Bearer <apiKey>` (Streamable HTTP).
- **REST:** `POST https://42mcp.tech/v1/connections/<connectionId>/invoke` with the same bearer key and `{"instruction":"…"}`.

**Scope:** login only — never account creation, never password capture/storage, write actions flagged for approval.
