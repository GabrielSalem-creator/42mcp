/**
 * Site connections: each is one authenticated website the user connected on the VM.
 * A connection exposes generated MCP tools + REST endpoints and caches workflow
 * recipes so repeat calls run without re-planning. Persisted as JSON in the data dir.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const FILE = path.join(config.dataDir, 'connections.json');

function load() {
  try {
    if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    console.error('[connections] read error:', e.message);
  }
  return { connections: {} };
}

function registrableDomain(rawUrl) {
  let host = String(rawUrl || '').trim();
  host = host.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].split('?')[0];
  return host.toLowerCase();
}

function slug(domain) {
  return domain.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

class ConnectionStore {
  constructor() {
    this.state = load();
    this.listeners = [];
  }

  onUpdate(fn) { this.listeners.push(fn); }
  notify(event, payload) {
    for (const fn of this.listeners) { try { fn(event, payload); } catch (_) {} }
  }
  save() {
    try { fs.writeFileSync(FILE, JSON.stringify(this.state, null, 2)); }
    catch (e) { console.error('[connections] write error:', e.message); }
  }

  list() { return Object.values(this.state.connections); }
  get(id) { return this.state.connections[id] || null; }

  getByDomain(domain) {
    return this.list().find((c) => c.domain === domain) || null;
  }

  /** Public, redacted view (no apiKey) for the UI/API. */
  publicView(c) {
    if (!c) return null;
    const { apiKey, ...rest } = c;
    return { ...rest, apiKeyPreview: apiKey ? apiKey.slice(0, 12) + '…' : null };
  }

  create({ url, label, single = true }) {
    const domain = registrableDomain(url);
    if (!domain) throw new Error('A valid website address is required.');
    const existing = this.getByDomain(domain);
    if (existing) { this.setActive(existing.id); return existing; }

    // Single-connection mode: one MCP target at a time. Switching sites removes the old one.
    if (single) {
      for (const other of this.list()) this.remove(other.id);
    }

    const id = 'conn_' + slug(domain) + '_' + crypto.randomBytes(3).toString('hex');
    const conn = {
      id,
      domain,
      url: /^https?:\/\//i.test(url) ? url : `https://${domain}`,
      label: label || domain,
      status: 'new', // new | authenticating | connected | needs_auth | error
      createdAt: new Date().toISOString(),
      lastActiveAt: null,
      apiKey: 'sk_live_' + crypto.randomBytes(20).toString('hex'),
      loginUrl: null,
      tools: [],       // [{ name, title, description, risk, inputSchema }]
      workflows: {},   // toolName -> { version, steps, lastSuccessAt, successRate }
      runs: []         // recent execution log (redacted)
    };
    this.state.connections[id] = conn;
    this.state.activeId = id;
    this.save();
    this.notify('connection_created', this.publicView(conn));
    return conn;
  }

  setActive(id) {
    if (this.state.connections[id]) { this.state.activeId = id; this.save(); }
    return this.get(id);
  }

  getActive() {
    return this.get(this.state.activeId) || this.list()[0] || null;
  }

  update(id, patch) {
    const c = this.get(id);
    if (!c) return null;
    Object.assign(c, patch, { lastActiveAt: new Date().toISOString() });
    this.save();
    this.notify('connection_updated', this.publicView(c));
    return c;
  }

  setStatus(id, status, extra = {}) {
    return this.update(id, { status, ...extra });
  }

  upsertTool(id, tool) {
    const c = this.get(id);
    if (!c) return null;
    const i = c.tools.findIndex((t) => t.name === tool.name);
    if (i >= 0) c.tools[i] = { ...c.tools[i], ...tool };
    else c.tools.push(tool);
    this.save();
    this.notify('connection_updated', this.publicView(c));
    return c;
  }

  saveWorkflow(id, toolName, steps) {
    const c = this.get(id);
    if (!c) return null;
    const prev = c.workflows[toolName];
    c.workflows[toolName] = {
      version: (prev?.version || 0) + 1,
      steps,
      lastSuccessAt: new Date().toISOString(),
      successRate: prev?.successRate ?? 1
    };
    this.save();
    return c.workflows[toolName];
  }

  getWorkflow(id, toolName) {
    return this.get(id)?.workflows?.[toolName] || null;
  }

  recordRun(id, run) {
    const c = this.get(id);
    if (!c) return null;
    c.runs.unshift({ at: new Date().toISOString(), ...run });
    if (c.runs.length > 50) c.runs.length = 50;
    this.save();
    this.notify('connection_updated', this.publicView(c));
    return c;
  }

  remove(id) {
    const c = this.get(id);
    if (!c) return false;
    delete this.state.connections[id];
    this.save();
    this.notify('connection_removed', { id });
    return true;
  }

  findByApiKey(key) {
    return this.list().find((c) => c.apiKey === key) || null;
  }
}

module.exports = new ConnectionStore();
module.exports.registrableDomain = registrableDomain;
