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

// Capture PNG then downscale to a small real JPEG with ImageMagick (keeps every
// frame light — a few tens of KB — so the live view stays responsive).
const SHOT = 'agent-browser screenshot /tmp/sitemcp_raw.png >/dev/null 2>&1; ' +
  'convert /tmp/sitemcp_raw.png -resize 1280x720\\> -quality 50 /tmp/sitemcp_screen.jpg 2>/dev/null || cp /tmp/sitemcp_raw.png /tmp/sitemcp_screen.jpg; ';

/** Base64 JPEG screenshot of the current page (fast, low-bandwidth). */
async function screenshotBase64() {
  const r = await browserShell(SHOT + 'base64 -w 0 /tmp/sitemcp_screen.jpg', 30000);
  return r.stdout.trim();
}

/** Screenshot + current url/title in one round-trip. */
async function getScreen() {
  const r = await browserShell(
    SHOT +
    'echo "===URL==="; agent-browser get url 2>/dev/null; echo "===TITLE==="; agent-browser get title 2>/dev/null; ' +
    'echo "===IMG==="; base64 -w 0 /tmp/sitemcp_screen.jpg',
    30000
  );
  const out = r.stdout || '';
  const url = (out.split('===URL===')[1] || '').split('===TITLE===')[0].trim();
  const title = (out.split('===TITLE===')[1] || '').split('===IMG===')[0].trim();
  const img = (out.split('===IMG===')[1] || '').trim();
  return { screenshot: img, url, title, mime: 'image/jpeg' };
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

/** Close every browser tab/session for a clean slate (logins persist on the profile). */
async function closeAll() {
  try { await agentBrowser(['close', '--all'], 20000); } catch (_) {}
  await sleep(600);
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
  getScreen,
  cookiesJson,
  open,
  closeAll,
  sleep
};
