# 42MCP — Turn any website into an MCP server & API

**Name a website. Sign in once on a private cloud browser. Get an always-online MCP
server and REST API for that site** — even when the site has no public API.

Most useful sites (Instagram, school portals, internal dashboards, CRMs, mailboxes)
either have no API or a locked-down one. 42MCP gives you a universal layer: a dedicated
cloud browser that stays logged in to **your own** account and exposes it to AI agents
and code as clean MCP tools and REST endpoints.

> **Live:** [https://42mcp.tech](https://42mcp.tech)

---

## How it works

1. **Ask.** On the web app you type a website — `instagram.com`, your university portal,
   a CRM, a mailbox.
2. **A private browser opens** on your dedicated cloud VM (persistent Chrome driven by
   [`agent-browser`](https://www.npmjs.com/package/agent-browser)).
3. **Sign in once.** A dynamic form shows the exact fields that site asks for
   (username/email, password, then a verification-code step if the site sends one).
   Values go straight into your own browser session — they are **not stored**. You can
   also just sign in by hand on the live screen and tap **Verify session**.
4. **Get your MCP + API.** You receive an **MCP URL**, a **REST endpoint**, and an
   **API key**, plus a box to run natural-language instructions and save good ones as
   reusable tools. Repeat calls reuse cached workflows so they run fast.

One active connection at a time — asking for a new site replaces the previous one, so the
environment stays specialised to exactly what you want.

```
 ┌──────────────┐   "I want an MCP for X"   ┌───────────────────────────┐
 │  Web chat UI │ ───────────────────────▶ │  Orchestrator (Node/Express)│
 │  (42mcp.tech)│ ◀─ MCP URL + API key ──  │  + per-connection MCP server │
 └──────────────┘                          └──────────────┬──────────────┘
         ▲  live screen / dynamic login                   │
         │                                                ▼
 ┌───────┴───────────────────────────────────────────────────────────────┐
 │  Dedicated cloud VM (Boxd · 4 vCPU / 16 GB · Ubuntu)                    │
 │  • persistent Chrome via agent-browser (display :100)                  │
 │  • site agent: bounded LLM action-loop → structured JSON + cached recipes│
 │  • encrypted per-connection session; login-only, never sign-up          │
 └────────────────────────────────────────────────────────────────────────┘
```

---

## AI model layer (bring your own)

The planner uses a **provider-agnostic, OpenAI-compatible LLM endpoint**. Point it at the
**Google Gemini API** or any **open-source model** served behind an OpenAI-compatible
proxy (vLLM, Ollama, LM Studio, OpenRouter, …). Configure it in `.env`:

```bash
ARTBLOOM_API_BASE=https://your-openai-compatible-endpoint/v1
ARTBLOOM_API_KEY=your_key
ARTBLOOM_MODEL=gemini-2.5-pro
```

No model is hard-coded into the product — the LLM is a swappable adapter behind the
workflow contract, so you can change providers without touching the automation layer.

---

## Quick start

```bash
npm install
cp .env.example .env     # fill in BOXD_API_KEY and your LLM endpoint
npm start                # http://localhost:3000  (drives your cloud VM)
```

Make it live on your own domain (runs the app on the VM):

```bash
npm run deploy           # upload + install + start the always-on service
```

See **[DEPLOY.md](./DEPLOY.md)** for the full VM + domain setup (DNS, custom domain, resize).

---

## Endpoints a connection gives you

- **MCP (Streamable HTTP):** `POST https://42mcp.tech/mcp/<connectionId>`
  with `Authorization: Bearer <apiKey>` — discoverable `tools/list` + `tools/call`,
  including a universal `run_instruction` tool.
- **REST:** `POST https://42mcp.tech/v1/connections/<connectionId>/invoke`
  with the same bearer key and `{"instruction":"get my latest 10 items"}`.

```bash
curl -X POST https://42mcp.tech/v1/connections/<id>/invoke \
  -H "Authorization: Bearer sk_live_..." \
  -H "Content-Type: application/json" \
  -d '{"instruction":"get my unread messages"}'
```

---

## Tech stack

| Layer | Tech |
|---|---|
| Web app + API | Node.js, Express, WebSocket |
| MCP | `@modelcontextprotocol/sdk` (Streamable HTTP), per-connection server |
| Cloud VM | [Boxd](https://boxd.sh) microVM — 4 vCPU / 16 GB, Ubuntu 24.04 |
| Browser automation | `agent-browser` (CDP) on an xpra desktop |
| Planner | OpenAI-compatible LLM (Gemini API or open-source) |
| Frontend | Vanilla JS single-page app, responsive, no build step |

---

## Repository layout

```
src/
  server.js           Express + WebSocket API, connection & MCP/REST routes
  mcpHttp.js          Per-connection MCP server over Streamable HTTP
  siteAgent.js        Login detection + bounded LLM action loop + workflow cache
  connectionStore.js  Single-active site connections, tools, API keys
  vmShell.js          agent-browser helpers on the cloud VM
  boxdClient.js       Boxd VM client (remote API or local exec)
  scraperEngine.js    Fast-path extractors (e.g. Instagram)
client/               index.html · style.css · app.js  (the web UI)
scripts/              deploy-vm.js · domain-setup.js · resize-vm.js · probe-vm.js
```

---

## Safety & scope

- **Login only.** The platform never creates accounts and never automates sign-up.
- **No password storage.** Credentials are typed into your own browser session and are not
  persisted or logged.
- **Write actions are flagged** and require explicit approval; it defaults to read-only.
- Operate only accounts **you are authorised to use**, and respect each site's terms.

---

## License

MIT
