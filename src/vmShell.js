const boxdClient = require('./boxdClient');
const config = require('./config');

/** Quote a string for POSIX sh single quotes. */
function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Common environment prefix for browser commands on the VM. */
function browserEnv() {
  return `export DISPLAY=${config.display}; export AGENT_BROWSER_PROFILE=${shq(config.browserProfileDir)}; `;
}

/**
 * Run `agent-browser <args...>` on the VM. Returns { stdout, stderr, exitCode }.
 */
async function agentBrowser(args, timeoutMs = 30000) {
  const cmd = browserEnv() + 'agent-browser ' + args.map(shq).join(' ');
  return boxdClient.exec(cmd, undefined, timeoutMs);
}

/** Run an arbitrary shell fragment with the browser env (DISPLAY/profile) prepared. */
async function browserShell(fragment, timeoutMs = 30000) {
  return boxdClient.exec(browserEnv() + fragment, undefined, timeoutMs);
}

async function getUrl() {
  const r = await agentBrowser(['get', 'url'], 15000);
  return r.stdout.trim().split('\n').pop() || '';
}

async function getTitle() {
  const r = await agentBrowser(['get', 'title'], 15000);
  return r.stdout.trim().split('\n').pop() || '';
}

/** Interactive accessibility snapshot (text form with refs). */
async function snapshot(opts = {}) {
  const args = ['snapshot'];
  if (opts.interactive !== false) args.push('-i');
  if (opts.compact) args.push('-c');
  if (opts.urls) args.push('-u');
  const r = await agentBrowser(args, 30000);
  return r.stdout;
}

/** Base64 PNG screenshot of the current page. */
async function screenshotBase64() {
  const r = await browserShell(
    'agent-browser screenshot /tmp/sitemcp_screen.png >/dev/null 2>&1; base64 -w 0 /tmp/sitemcp_screen.png',
    40000
  );
  return r.stdout.trim();
}

async function cookiesJson() {
  const r = await agentBrowser(['cookies', 'get', '--json'], 20000);
  try {
    const start = r.stdout.indexOf('{');
    const parsed = JSON.parse(r.stdout.slice(start));
    return parsed?.data?.cookies || parsed?.cookies || [];
  } catch (_) {
    return [];
  }
}

async function open(url) {
  return agentBrowser(['open', url], 60000);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  shq,
  browserEnv,
  agentBrowser,
  browserShell,
  getUrl,
  getTitle,
  snapshot,
  screenshotBase64,
  cookiesJson,
  open,
  sleep
};
