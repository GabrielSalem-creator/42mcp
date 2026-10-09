/**
 * Site agent: understands and operates ONE authenticated website inside the VM
 * browser on behalf of its owner. It drives agent-browser through a bounded
 * action loop (navigate / snapshot / click / fill / extract), returns clean
 * JSON, and records a reusable workflow recipe per tool so repeats are cheap.
 *
 * Scope guardrails:
 *  - Login only. It never creates accounts; a page that looks like sign-up is refused.
 *  - It operates the user's own logged-in session; it does not capture or store passwords.
 *  - Write actions are flagged and require explicit approval from the caller.
 */
const vm = require('./vmShell');
const config = require('./config');
const connections = require('./connectionStore');

const ROLE_RE = /^\s*-\s+([A-Za-z]+)/;

/** Parse an agent-browser interactive snapshot into a compact element list. */
function parseSnapshot(text) {
  const els = [];
  for (const line of String(text || '').split('\n')) {
    const roleM = line.match(ROLE_RE);
    if (!roleM) continue;
    const refM = line.match(/ref=(e\d+)/);
    if (!refM) continue;
    const nameM = line.match(/"((?:[^"\\]|\\.)*)"/);
    els.push({
      ref: refM[1],
      role: roleM[1].toLowerCase(),
      name: nameM ? nameM[1].trim() : '',
      attrs: (line.match(/\[([^\]]*)\]/g) || []).join(' ')
    });
  }
  return els;
}

function looksLikeSignup(elements, title) {
  const hay = (title + ' ' + elements.map((e) => e.name).join(' ')).toLowerCase();
  const signup = /(create account|create an account|sign ?up|register|join free|new to)/.test(hay);
  const login = /(log ?in|sign ?in|password)/.test(hay);
  return signup && !login;
}

/** Heuristic: is the current page an authenticated (non-login) view? */
function isAuthenticated(elements, url, title) {
  const hay = (title + ' ' + elements.map((e) => e.name).join(' ')).toLowerCase();
  const hasPassword = elements.some((e) => /password/i.test(e.name) || /password/i.test(e.attrs));
  const onLoginUrl = /(login|signin|sign-in|auth|sso)/i.test(url);
  const accountMarkers = /(log ?out|sign ?out|account|profile|dashboard|inbox|feed|settings|home)/.test(hay);
  if (hasPassword || onLoginUrl) return false;
  return accountMarkers;
}

/** Open the site and report whether the owner's session is active. */
async function verifySession(conn) {
  await vm.open(conn.url);
  await vm.sleep(2500);
  const [url, title, snap] = await Promise.all([vm.getUrl(), vm.getTitle(), vm.snapshot()]);
  const els = parseSnapshot(snap);
  const authed = isAuthenticated(els, url, title);
  connections.setStatus(conn.id, authed ? 'connected' : 'needs_auth', { loginUrl: url });
  return { authenticated: authed, url, title };
}

/**
 * Open the site's login page and return a UI form schema describing the fields
 * the site itself asks for. Drives the OWNER's own sign-in; no values are stored.
 */
async function detectLoginForm(conn) {
  const loginGuesses = [
    conn.loginUrl,
    `https://${conn.domain}/login`,
    `https://${conn.domain}/signin`,
    `https://${conn.domain}/account/login`,
    `https://${conn.domain}/users/sign_in`,
    `https://${conn.domain}/auth/login`,
    conn.url
  ].filter(Boolean);

  let best = null;        // page with a password field — the real login
  let fallback = null;    // a login-URL page with any input
  for (const g of loginGuesses) {
    await vm.open(g);
    await vm.sleep(2000);
    const url = await vm.getUrl();
    const title = await vm.getTitle();
    const els = parseSnapshot(await vm.snapshot());
    const hasPassword = els.some((e) => /textbox/.test(e.role) && /password|passcode|\bpin\b/i.test(e.name));
    const onLoginUrl = /login|signin|sign-in|sign_in|auth/i.test(url);
    const hasInput = els.some((e) => /textbox|combobox/.test(e.role));
    if (hasPassword) { best = { url, title, els }; break; }
    if (!fallback && onLoginUrl && hasInput) fallback = { url, title, els };
  }
  const chosen = best || fallback || { url: await vm.getUrl(), title: await vm.getTitle(), els: parseSnapshot(await vm.snapshot()) };
  const els = chosen.els;
  if (looksLikeSignup(els, chosen.title)) {
    return { ok: false, reason: 'signup_page', message: 'This looks like a sign-up page. This tool only signs in to accounts you already have.' };
  }

  const fields = [];
  const ssoButtons = [];
  for (const e of els) {
    const n = e.name.toLowerCase();
    if (/textbox|combobox/.test(e.role)) {
      let type = 'text', id = e.ref;
      if (/verification|security|confirmation|one.?time|2fa|two.?factor|\bcode\b|passcode|digit/.test(n)) type = 'otp';
      else if (/password|passcode|\bpin\b/.test(n)) type = 'password';
      else if (/e-?mail|courriel/.test(n)) type = 'email';
      else if (/phone|mobile|sms/.test(n)) type = 'tel';
      else if (/user ?name|user id|login|account|identifier|handle/.test(n)) type = 'username';
      fields.push({ ref: e.ref, id, label: e.name || type, type, required: /required/i.test(e.attrs) });
    } else if (/button|link/.test(e.role) && /with\s+(google|apple|microsoft|facebook|github|passkey|sso|email link)/i.test(n)) {
      ssoButtons.push({ ref: e.ref, label: e.name });
    }
  }
  const submit = els.find((e) => /button/.test(e.role) && /^(log ?in|sign ?in|continue|next|submit|verify|confirm)\b/i.test(e.name));
  return {
    ok: true,
    url: chosen.url,
    title: chosen.title,
    fields,
    ssoButtons,
    submitRef: submit?.ref || null,
    hasPassword: fields.some((f) => f.type === 'password'),
    hasOtp: fields.some((f) => f.type === 'otp')
  };
}

/** Type the owner's own values into the detected fields and submit. Not stored. */
async function fillLogin(conn, values = {}, submit = true) {
  const form = await detectLoginForm(conn);
  if (!form.ok) return form;
  for (const f of form.fields) {
    const v = values[f.id] ?? values[f.type] ?? values[f.ref];
    if (v == null || v === '') continue;
    await vm.agentBrowser(['fill', '@' + f.ref, String(v)], 15000);
  }
  if (submit && form.submitRef) {
    await vm.agentBrowser(['click', '@' + form.submitRef], 15000);
    await vm.sleep(3000);
  }
  const [url, title, snap] = await Promise.all([vm.getUrl(), vm.getTitle(), vm.snapshot()]);
  const els = parseSnapshot(snap);
  return {
    ok: true,
    submitted: Boolean(submit && form.submitRef),
    authenticated: isAuthenticated(els, url, title),
    needsOtp: els.some((e) => /verification|security|code|2fa|two.?factor|digit/i.test(e.name)),
    url, title
  };
}

// ---------- instruction execution (LLM action loop over agent-browser) ----------

const ACTION_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'browser',
      description: 'Operate the authenticated browser. One action per call.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['navigate', 'snapshot', 'click', 'fill', 'press', 'scroll', 'read', 'extract', 'finish'] },
          url: { type: 'string', description: 'For navigate.' },
          ref: { type: 'string', description: 'Element ref like e12 for click/fill.' },
          text: { type: 'string', description: 'Text for fill.' },
          key: { type: 'string', description: 'Key for press, e.g. Enter.' },
          direction: { type: 'string', enum: ['up', 'down'], description: 'For scroll.' },
          result: { description: 'For finish/extract: the structured JSON result to return to the user.' },
          risk: { type: 'string', enum: ['read', 'write'], description: 'For finish: whether any state-changing action occurred.' }
        },
        required: ['action']
      }
    }
  }
];

async function runAction(a) {
  switch (a.action) {
    case 'navigate': await vm.open(a.url); await vm.sleep(2000); return trimmed(await vm.snapshot());
    case 'snapshot': return trimmed(await vm.snapshot());
    case 'click': await vm.agentBrowser(['click', '@' + String(a.ref).replace(/^@/, '')], 15000); await vm.sleep(1500); return trimmed(await vm.snapshot());
    case 'fill': await vm.agentBrowser(['fill', '@' + String(a.ref).replace(/^@/, ''), String(a.text || '')], 15000); return 'filled';
    case 'press': await vm.agentBrowser(['press', String(a.key || 'Enter')], 12000); await vm.sleep(1500); return trimmed(await vm.snapshot());
    case 'scroll': await vm.agentBrowser(['scroll', a.direction === 'up' ? 'up' : 'down', '900'], 12000); return trimmed(await vm.snapshot());
    case 'read': { const r = await vm.agentBrowser(['read'], 30000); return (r.stdout || '').slice(0, 6000); }
    default: return 'ok';
  }
}

function trimmed(snap) {
  return String(snap || '').split('\n').slice(0, 120).join('\n').slice(0, 6000);
}

async function artbloomChat(messages, tools) {
  const url = config.artbloomBaseUrl.replace(/\/$/, '') + '/chat/completions';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.artbloomTimeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.artbloomApiKey}` },
      body: JSON.stringify({ model: config.artbloomModel, messages, tools, tool_choice: 'auto', temperature: 0.1, max_tokens: 1500 }),
      signal: controller.signal
    });
  } finally { clearTimeout(timer); }
  const text = await res.text();
  if (!res.ok) throw new Error(`LLM ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const SYSTEM = (conn) => `You operate the website ${conn.domain} inside a real Chrome browser where the user is already signed in to their own account.
Goal: carry out the user's instruction and return clean structured JSON.

Rules:
- Use the "browser" tool for every step: navigate, snapshot (to see refs like e12), click, fill, press, scroll, read, extract, finish.
- Refs come only from the latest snapshot and go stale after any change — re-snapshot after navigation/clicks.
- This is login-only automation of the user's OWN account. Never register, create accounts, or change passwords/security settings.
- Prefer reading data. If the instruction requires a state-changing action (send, post, delete, buy), set risk:"write" and stop at finish with a clear summary instead of performing it unless the instruction clearly authorizes that exact action.
- When done, call browser with action:"finish", put the answer in "result" as JSON, and set "risk".
- Keep to at most 12 steps.`;

/**
 * Run a natural-language instruction against the connection. Returns
 * { ok, result, risk, steps, toolName }.
 */
async function runInstruction(conn, instruction, { maxSteps = 12 } = {}) {
  if (!config.artbloomApiKey) {
    return { ok: false, error: 'No planner LLM configured (ARTBLOOM_API_KEY).' };
  }
  await vm.open(conn.url);
  await vm.sleep(1500);

  const messages = [
    { role: 'system', content: SYSTEM(conn) },
    { role: 'user', content: instruction },
    { role: 'user', content: 'Current page snapshot:\n' + trimmed(await vm.snapshot()) }
  ];

  const stepLog = [];
  for (let step = 0; step < maxSteps; step++) {
    let data;
    try { data = await artbloomChat(messages, ACTION_TOOLS); }
    catch (e) { return { ok: false, error: e.message, steps: stepLog }; }
    const msg = data.choices?.[0]?.message || {};
    if (!msg.tool_calls?.length) {
      const text = (msg.content || '').trim();
      return { ok: true, result: text || 'Done.', risk: 'read', steps: stepLog };
    }
    messages.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });
    for (const call of msg.tool_calls) {
      let args = {};
      try { args = JSON.parse(call.function?.arguments || '{}'); } catch (_) {}
      if (args.action === 'finish' || args.action === 'extract') {
        const result = args.result ?? (msg.content || '').trim();
        const risk = args.risk || 'read';
        connections.recordRun(conn.id, { instruction, risk, steps: stepLog.length });
        return { ok: true, result, risk, steps: stepLog };
      }
      let obs;
      try { obs = await runAction(args); }
      catch (e) { obs = 'error: ' + e.message; }
      stepLog.push({ action: args.action, ref: args.ref, url: args.url });
      messages.push({ role: 'tool', tool_call_id: call.id, content: String(obs).slice(0, 6000) });
    }
  }
  return { ok: true, result: 'Reached step limit without a final answer.', risk: 'read', steps: stepLog, partial: true };
}

module.exports = {
  verifySession,
  detectLoginForm,
  fillLogin,
  runInstruction,
  parseSnapshot,
  isAuthenticated
};
