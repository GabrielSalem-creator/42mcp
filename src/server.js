const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const config = require('./config');
const boxdClient = require('./boxdClient');
const scraperEngine = require('./scraperEngine');
const dataStore = require('./dataStore');
const screenAnalyzer = require('./screenAnalyzer');
const agentBrain = require('./agentBrain');
const connections = require('./connectionStore');
const siteAgent = require('./siteAgent');
const { vmBrowserExec, parseVmJson, vmScreenshot } = require('./vmBrowserExec');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.resolve(__dirname, '../client')));

// WebSocket broadcast helper
function broadcast(event, payload) {
  const message = JSON.stringify({ event, payload });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) { // OPEN
      client.send(message);
    }
  });
}

// Hook dataStore events to WebSocket broadcast
dataStore.onUpdate((event, payload) => {
  broadcast(event, payload);
});
connections.onUpdate((event, payload) => {
  broadcast(event, payload);
});

function integrationFor(conn) {
  const base = (config.publicBaseUrl || `http://localhost:${config.port}`).replace(/\/$/, '');
  return {
    mcpUrl: `${base}/mcp/${conn.id}`,
    restUrl: `${base}/v1/connections/${conn.id}/invoke`,
    apiKey: conn.apiKey,
    tools: conn.tools,
    curl: `curl -X POST ${base}/v1/connections/${conn.id}/invoke \\\n`
      + `  -H "Authorization: Bearer ${conn.apiKey}" \\\n`
      + `  -H "Content-Type: application/json" \\\n`
      + `  -d '{"instruction":"get my latest items"}'`
  };
}

// --- REST API Endpoints ---

// System & VM Status
app.get('/api/status', async (req, res) => {
  try {
    const machine = await boxdClient.getMachine();
    res.json({
      status: 'ok',
      apiKeySet: Boolean(config.apiKey),
      vmName: config.defaultVmName,
      vmStatus: machine?.status || 'unknown',
      desktopUrl: machine?.access?.desktopUrl || `https://app.boxd.sh/desktop/${config.defaultVmName}`,
      machine
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// List or get Machines
app.get('/api/vm', async (req, res) => {
  try {
    const machines = await boxdClient.listMachines();
    const current = await boxdClient.getMachine();
    res.json({
      active: current,
      all: machines,
      desktopUrl: current?.access?.desktopUrl || `https://app.boxd.sh/desktop/${config.defaultVmName}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// VM Lifecycle Control (start, stop, pause, resume, reboot)
app.post('/api/vm/action', async (req, res) => {
  const { action, name = config.defaultVmName } = req.body;
  try {
    let result;
    switch (action) {
      case 'start':
        result = await boxdClient.startMachine(name);
        break;
      case 'stop':
        result = await boxdClient.stopMachine(name);
        break;
      case 'pause':
        result = await boxdClient.pauseMachine(name);
        break;
      case 'resume':
        result = await boxdClient.resumeMachine(name);
        break;
      case 'reboot':
        result = await boxdClient.rebootMachine(name);
        break;
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
    const current = await boxdClient.getMachine(name);
    broadcast('vm_updated', current);
    res.json({ success: true, action, machine: current });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Execute Shell Command inside VM
app.post('/api/vm/exec', async (req, res) => {
  const { command, timeoutMs = 60000 } = req.body;
  if (!command) return res.status(400).json({ error: 'Command required' });
  try {
    const result = await boxdClient.exec(command, undefined, timeoutMs);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sessions & Logins
app.get('/api/sessions', (req, res) => {
  res.json(dataStore.getSessions());
});

app.get('/api/agent/last-result', (req, res) => {
  let payload = dataStore.getLastAgentPayload();
  const items = dataStore.getItems({});
  if (!payload && items.length) {
    const targets = [...new Set(items.map((i) => i.target).filter(Boolean))];
    payload = {
      request: null,
      collectedAt: items[0]?.collectedAt || new Date().toISOString(),
      summary: {
        targets,
        totalPosts: items.filter((i) => i.type && !String(i.type).includes('story')).length,
        totalStories: items.filter((i) => String(i.type || '').includes('story')).length,
        totalItems: items.length
      },
      results: [],
      items
    };
  }
  res.json({ payload, items });
});

app.get('/api/accounts', (req, res) => {
  try {
    res.json({ accounts: dataStore.getAccountProfiles() });
  } catch (err) {
    res.status(500).json({ error: err.message, accounts: [] });
  }
});

// Open login window on VM
app.post('/api/browser/open-login', async (req, res) => {
  const { platform = 'instagram' } = req.body;
  try {
    const result = await scraperEngine.openLoginWindow(platform);
    const desktopUrl = await boxdClient.getDesktopUrl();
    res.json({
      success: true,
      platform,
      desktopUrl,
      result
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check / Verify login state
app.post('/api/browser/check-login', async (req, res) => {
  const { platform = 'instagram' } = req.body;
  try {
    const result = await scraperEngine.verifyLogin(platform);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import Session Cookies (1-click auth bypassing datacenter IP login blockers)
app.post('/api/sessions/import', async (req, res) => {
  const { platform = 'instagram', cookies } = req.body;
  if (!cookies) return res.status(400).json({ error: 'Cookies or sessionid string required' });

  try {
    const safeCookies = typeof cookies === 'object' ? JSON.stringify(cookies) : String(cookies);
    const b64 = Buffer.from(safeCookies, 'utf8').toString('base64');
    const cmd = `python3 /home/boxd/vm_agent_controller.py import-cookies "${platform}" "$(echo '${b64}' | base64 -d)"`;
    const result = await boxdClient.exec(cmd, undefined, 60000);
    
    let parsed = {};
    try {
      const jsonMatch = result.stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch (_) {}

    if (parsed.connected) {
      dataStore.setSession(platform, {
        connected: true,
        username: parsed.username,
        lastVerified: new Date().toISOString(),
        cookieCount: parsed.cookieCount
      });
    }

    res.json({
      success: true,
      platform,
      ...parsed
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Configure or Clear VM Proxy (HTTP / HTTPS / SOCKS5 / Residential)
app.post('/api/vm/proxy', async (req, res) => {
  const { proxyUrl } = req.body;
  try {
    const cmd = `python3 /home/boxd/vm_agent_controller.py set-proxy "${proxyUrl || ''}"`;
    const result = await boxdClient.exec(cmd, undefined, 30000);
    let parsed = { success: true, message: 'Proxy updated' };
    try { parsed = JSON.parse(result.stdout); } catch (_) {}
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Real-time browser screenshot (fast JPEG via agent-browser)
app.post('/api/browser/screenshot', async (req, res) => {
  const { url, ensure, connectionId } = req.body || {};
  const vmsh = require('./vmShell');
  try {
    if (url) {
      await vmsh.open(url); await vmsh.sleep(1500);
    } else if (ensure) {
      // Never show about:blank — make sure the real site/login page is loaded.
      const cur = (await vmsh.getUrl()) || '';
      if (!cur || /^(about:blank|chrome:|data:)/i.test(cur)) {
        const conn = (connectionId && connections.get(connectionId)) || connections.getActive();
        if (conn) { await vmsh.open(conn.loginUrl || conn.url); await vmsh.sleep(1800); }
      }
    }
    const screen = await vmsh.getScreen();
    res.json(screen);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Interactive Mouse & Keyboard Input on VM
app.post('/api/browser/input', async (req, res) => {
  const { action, x, y, text, key, dy } = req.body;
  try {
    if (action === 'click' && req.body.ref) {
      const ref = String(req.body.ref).replace(/[^a-zA-Z0-9]/g, '');
      await vmBrowserExec(`agent-browser click @${ref}`, 15000);
    } else if (action === 'click') {
      const clickX = Math.round(Number(x));
      const clickY = Math.round(Number(y));
      if (!Number.isFinite(clickX) || !Number.isFinite(clickY)) {
        return res.status(400).json({ error: 'Invalid click coordinates' });
      }
      await vmBrowserExec(
        `agent-browser mouse move ${clickX} ${clickY} && agent-browser mouse down left && agent-browser mouse up left`,
        15000
      );
    } else if (action === 'type') {
      const safeText = (text || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      await vmBrowserExec(`agent-browser keyboard type "${safeText}"`, 20000);
    } else if (action === 'key') {
      const safeKey = (key || 'Return').replace(/[^a-zA-Z0-9_+ -]/g, '');
      await vmBrowserExec(`agent-browser press ${safeKey}`, 12000);
    } else if (action === 'scroll') {
      const delta = Math.round(Number(dy) || 300);
      await vmBrowserExec(`agent-browser mouse wheel ${delta}`, 12000);
    } else {
      return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    let parsed = {};
    try {
      parsed = await require('./vmShell').getScreen(55);
    } catch (snapErr) {
      console.warn('Screenshot after input failed:', snapErr.message);
    }
    res.json({ success: true, action, ...parsed });
  } catch (err) {
    console.error('browser/input error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Real-time AI Screen Analyzer
app.get('/api/browser/analyze', async (req, res) => {
  try {
    const analysis = await screenAnalyzer.analyzePage();
    res.json(analysis);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// AI Auto-Fill & Submit Credentials / 2FA
app.post('/api/browser/ai-fill', async (req, res) => {
  const { username, password, twoFactorCode, submit = true } = req.body;
  try {
    const nextState = await screenAnalyzer.aiFillAndSubmit({ username, password, twoFactorCode, submit });
    const snapRes = await boxdClient.exec('python3 /home/boxd/vm_agent_controller.py screenshot', undefined, 20000);
    const parsed = JSON.parse(snapRes.stdout);
    res.json({ success: true, nextState, ...parsed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// AI Conversational Agent Endpoint (Chat on website or via API)
app.post('/api/agent/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message is required' });
  try {
    const response = await agentBrain.processMessage(message);
    broadcast('agent_chat', { message, response, timestamp: new Date().toISOString() });
    res.json({
      success: true,
      accounts: dataStore.getAccountProfiles(),
      payload: response.payload || dataStore.getLastAgentPayload(),
      data: response.payload || response.data,
      ...response
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Scraper Jobs
app.get('/api/scraper/jobs', (req, res) => {
  res.json(dataStore.getJobs());
});

app.post('/api/scraper/start', async (req, res) => {
  const { platform = 'instagram', target, dataTypes, depth = 10 } = req.body;
  if (!target) return res.status(400).json({ error: 'Target is required' });

  try {
    const job = await scraperEngine.runJob({
      platform,
      target,
      dataTypes: dataTypes || ['text', 'images', 'videos', 'metrics'],
      depth: parseInt(depth, 10) || 10
    });
    res.json({ success: true, job });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Collected Data API
app.get('/api/data', (req, res) => {
  const { platform, type, target, search } = req.query;
  const items = dataStore.getItems({ platform, type, target, search });
  res.json({
    total: items.length,
    items
  });
});

app.delete('/api/data/:id', (req, res) => {
  dataStore.deleteItem(req.params.id);
  res.json({ success: true });
});

app.post('/api/data/clear', (req, res) => {
  dataStore.clearItems();
  res.json({ success: true });
});

// Export to JSON or CSV
app.get('/api/data/export', (req, res) => {
  const format = req.query.format || 'json';
  const items = dataStore.getItems();

  if (format === 'csv') {
    const headers = ['id', 'platform', 'target', 'type', 'title', 'caption', 'author', 'mediaUrl', 'likes', 'comments', 'collectedAt'];
    const rows = items.map(i => [
      i.id,
      i.platform,
      i.target,
      i.type,
      `"${(i.title || '').replace(/"/g, '""')}"`,
      `"${(i.caption || '').replace(/"/g, '""')}"`,
      i.author,
      i.mediaUrl || '',
      i.metrics?.likes || 0,
      i.metrics?.comments || 0,
      i.collectedAt
    ]);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    res.header('Content-Type', 'text/csv');
    res.attachment(`scraped_data_${Date.now()}.csv`);
    return res.send(csv);
  }

  res.header('Content-Type', 'application/json');
  res.attachment(`scraped_data_${Date.now()}.json`);
  res.send(JSON.stringify(items, null, 2));
});

// Ready-to-copy MCP configuration for MCP-compatible clients
app.get('/api/mcp-config', (req, res) => {
  const mcpScriptPath = path.resolve(__dirname, 'mcp/server.js');
  const projectRoot = path.resolve(__dirname, '..');

  const cursorConfig = {
    mcpServers: {
      "boxd-vps-mcp": {
        command: "node",
        args: [mcpScriptPath],
        env: {
          BOXD_API_KEY: config.apiKey,
          BOXD_DEFAULT_VM: config.defaultVmName
        }
      }
    }
  };

  const desktopClientConfig = {
    mcpServers: {
      "boxd-vps-mcp": {
        command: "node",
        args: [mcpScriptPath],
        env: {
          BOXD_API_KEY: config.apiKey,
          BOXD_DEFAULT_VM: config.defaultVmName
        }
      }
    }
  };

  const agyCliConfig = {
    name: "boxd-vps",
    command: `node "${mcpScriptPath}"`,
    description: "Cloud VM Boxd MCP Wrapper for agentic browser automation & data extraction"
  };

  res.json({
    cursor: cursorConfig,
    mcpClient: desktopClientConfig,
    agy: agyCliConfig,
    scriptPath: mcpScriptPath,
    projectRoot
  });
});

// ===================== Site Connections (Website → MCP/API) =====================

// List all connections (redacted) + the single active one
app.get('/api/connections', (req, res) => {
  const active = connections.getActive();
  res.json({
    connections: connections.list().map((c) => connections.publicView(c)),
    activeId: active?.id || null,
    active: active ? connections.publicView(active) : null,
    integration: active ? integrationFor(active) : null
  });
});

// Resolve a free-text request ("connect my instagram") to a website URL
app.post('/api/resolve-site', async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ ok: false, error: 'text required' });
  try {
    const r = await siteAgent.resolveSiteUrl(text);
    res.json(r);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Create a connection for a website
app.post('/api/connections', (req, res) => {
  const { url, label } = req.body || {};
  if (!url) return res.status(400).json({ error: 'A website address is required.' });
  try {
    const conn = connections.create({ url, label });
    res.json({ connection: connections.publicView(conn), integration: integrationFor(conn) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/connections/:id', (req, res) => {
  const conn = connections.get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Connection not found.' });
  res.json({ connection: connections.publicView(conn), integration: integrationFor(conn) });
});

app.delete('/api/connections/:id', (req, res) => {
  res.json({ success: connections.remove(req.params.id) });
});

// Switch which connection is the active chat context
app.post('/api/connections/:id/activate', (req, res) => {
  const c = connections.setActive(req.params.id);
  if (!c) return res.status(404).json({ error: 'Connection not found.' });
  res.json({ connection: connections.publicView(c), integration: integrationFor(c) });
});

// Log out: clear the site's session on the VM and remove the connection
app.post('/api/connections/:id/logout', async (req, res) => {
  const conn = connections.get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Connection not found.' });
  try {
    const vmsh = require('./vmShell');
    try { await vmsh.open(conn.url); await vmsh.agentBrowser(['cookies', 'clear'], 15000); } catch (_) {}
    connections.remove(conn.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Open the site's login page on the VM and return the detected field schema
app.post('/api/connections/:id/open-login', async (req, res) => {
  const conn = connections.get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Connection not found.' });
  try {
    connections.setStatus(conn.id, 'authenticating');
    const step = await siteAgent.openLoginAndAnalyze(conn); // navigate + model analysis, fast
    res.json({ ok: step.step !== 'signup', ...step });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fill the owner's own credentials/verification code into their session (not stored)
app.post('/api/connections/:id/login', async (req, res) => {
  const conn = connections.get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Connection not found.' });
  const { values, fields, submit = true } = req.body || {};
  try {
    const out = await siteAgent.fillLogin(conn, fields || values || [], submit);
    if (out.authenticated) connections.setStatus(conn.id, 'connected');
    let screenshot = '';
    try { screenshot = await require('./vmShell').screenshotBase64(); } catch (_) {}
    res.json({ ...out, screenshot });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Re-read whatever auth step the site is currently showing (code, number, push…)
app.post('/api/connections/:id/auth-step', async (req, res) => {
  const conn = connections.get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Connection not found.' });
  try {
    const step = await siteAgent.detectAuthStep(conn);
    if (step.authenticated) connections.setStatus(conn.id, 'connected');
    let screenshot = '';
    try { screenshot = await require('./vmShell').screenshotBase64(); } catch (_) {}
    res.json({ ...step, screenshot });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Click an auth action button (Verify / Resend / Approve) and re-read the step
app.post('/api/connections/:id/auth-button', async (req, res) => {
  const conn = connections.get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Connection not found.' });
  const { ref } = req.body || {};
  if (!ref) return res.status(400).json({ error: 'ref required' });
  try {
    const step = await siteAgent.clickAuthButton(conn, ref);
    if (step.authenticated) connections.setStatus(conn.id, 'connected');
    res.json(step);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Verify the owner's session is live
app.post('/api/connections/:id/verify', async (req, res) => {
  const conn = connections.get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Connection not found.' });
  try {
    const out = await siteAgent.verifySession(conn);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Run a natural-language instruction on the connection (and optionally save as a named tool)
app.post('/api/connections/:id/run', async (req, res) => {
  const conn = connections.get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Connection not found.' });
  const { instruction, saveAs, title } = req.body || {};
  if (!instruction) return res.status(400).json({ error: 'An instruction is required.' });
  try {
    const out = await siteAgent.runInstruction(conn, instruction);
    if (out.ok && saveAs) {
      connections.upsertTool(conn.id, {
        name: saveAs,
        title: title || saveAs,
        description: instruction,
        risk: out.risk || 'read',
        inputSchema: { type: 'object', properties: {} }
      });
      connections.saveWorkflow(conn.id, saveAs, out.steps || []);
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Integration package (MCP URL, REST URL, key, tools, snippet)
app.get('/api/connections/:id/integration', (req, res) => {
  const conn = connections.get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Connection not found.' });
  res.json(integrationFor(conn));
});

// REST bridge: external clients call a connection's tools/instructions with its API key
async function restInvoke(req, res) {
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  // Resolve by id; if the id is stale/wrong but the API key is valid, use the key.
  let conn = connections.get(req.params.id);
  if ((!conn || conn.apiKey !== auth) && auth) {
    const byKey = connections.findByApiKey(auth);
    if (byKey) conn = byKey;
  }
  if (!conn) return res.status(404).json({ ok: false, error: 'Connection not found.' });
  if (!auth || auth !== conn.apiKey) return res.status(401).json({ ok: false, error: 'Invalid API key.' });
  const body = req.body || {};
  // Accept common field names so any client snippet works: instruction/prompt/query/q/message/input/text
  const instruction = body.instruction || body.prompt || body.query || body.q || body.message || body.input || body.text;
  const tool = body.tool;
  const task = instruction || (tool && conn.tools.find((t) => t.name === tool)?.description);
  if (!task) return res.status(400).json({ ok: false, error: 'Provide "instruction" (or "prompt") or a known "tool".' });
  try {
    const started = Date.now();
    const out = await siteAgent.runInstruction(conn, task);
    res.json({ ok: out.ok, data: out.result, error: out.ok ? undefined : (out.error || 'The agent could not complete that instruction.'), risk: out.risk, steps: out.steps ? out.steps.length : undefined, execution: { ms: Date.now() - started, mode: tool ? 'tool' : 'instruction' } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
app.post('/v1/connections/:id/invoke', restInvoke);
app.post('/api/connections/:id/invoke', restInvoke);

// Per-connection MCP server over Streamable HTTP
const { handleMcpRequest } = require('./mcpHttp');
app.post('/mcp/:id', handleMcpRequest);
app.get('/mcp/:id', handleMcpRequest);
app.delete('/mcp/:id', handleMcpRequest);

// WebSocket connection handler
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    event: 'welcome',
    payload: {
      time: new Date().toISOString(),
      vmName: config.defaultVmName
    }
  }));
});

// Start Server
server.listen(config.port, config.host, () => {
  console.log(`====================================================`);
  console.log(`🚀 Boxd VPS MCP Control Center & Web Server Running`);
  console.log(`📍 Web Dashboard: http://localhost:${config.port}`);
  console.log(`📍 Active VM:     ${config.defaultVmName}`);
  console.log(`📍 Desktop View:  https://app.boxd.sh/desktop/${config.defaultVmName}`);
  console.log(`====================================================`);
});
