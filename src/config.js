const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const localExec = ['1', 'true', 'yes'].includes(String(process.env.VM_LOCAL || '').toLowerCase());

module.exports = {
  apiKey: process.env.BOXD_API_KEY || '',
  defaultVmName: process.env.BOXD_DEFAULT_VM || 'sitemcp-core',
  port: parseInt(process.env.PORT, 10) || 3000,
  host: process.env.HOST || '0.0.0.0',
  dataDir: process.env.DATA_DIR && path.isAbsolute(process.env.DATA_DIR)
    ? process.env.DATA_DIR
    : path.resolve(__dirname, '../data'),

  /** true when this process runs inside the Boxd VM: shell commands run locally. */
  localExec,
  /** Public HTTPS base of the VM app (Boxd default route). */
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),

  // Browser on the VM (agent-browser on the xpra desktop :100)
  display: process.env.VM_DISPLAY || ':100',
  browserProfileDir: '/home/boxd/.config/chrome-agent-profile',
  sessionsDir: '/home/boxd/sitemcp-sessions',
  remoteDaemonPort: 8888,

  // Planner brains
  agentBrains: (process.env.AGENT_BRAINS || 'cursor,artbloom,local')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  cursorModel: process.env.CURSOR_MODEL || 'auto',
  cursorBin: '/home/boxd/.local/bin/agent',
  agentWorkspace: '/home/boxd/agent-ws',

  // Artbloom (OpenAI-compatible) fallback LLM
  artbloomApiKey: process.env.ARTBLOOM_API_KEY || '',
  artbloomBaseUrl: process.env.ARTBLOOM_API_BASE || 'https://api.artbloom.tech/v1',
  artbloomModel: process.env.ARTBLOOM_MODEL || 'gemini-2.5-pro',
  artbloomTimeoutMs: parseInt(process.env.ARTBLOOM_TIMEOUT_MS, 10) || 90000,
};
