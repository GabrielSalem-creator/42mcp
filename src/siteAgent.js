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

// Any alternative sign-in method a site might offer (never sign-up).
const SIGNIN_METHOD = /(continue with|sign ?in with|log ?in with|with (google|apple|microsoft|facebook|github|x\b|twitter|linkedin|okta|slack|discord|email|phone)|single sign|\bsso\b|passkey|magic link|email link|use (phone|email|a code)|one-?time|login code|sign ?in to)/i;
function isSignInMethod(name) {
  const n = (name || '').toLowerCase();
  if (/sign ?up|register|create (an )?account/.test(n)) return false; // never signup
  return SIGNIN_METHOD.test(n);
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
  const onLoginUrl = /(login|signin|sign-in|sign_in|auth|sso)/i.test(url);
  // A visible "Sign in / Sign up / Log in / Get started" control (without a matching sign-out) means signed OUT.
  const signedOutCta = elements.some((e) => /button|link/.test(e.role) && /^(sign ?in|sign ?up|log ?in|create (an )?account|get started|join)\b/i.test(e.name));
  const hasSignOut = /(log ?out|sign ?out)/.test(hay);
  if (hasPassword || onLoginUrl) return false;
  if (signedOutCta && !hasSignOut) return false;
  // Strong signals of being inside an account.
  return hasSignOut || /(your profile|my account|dashboard|avatar|account menu|notifications)/.test(hay);
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
  // Fallback: open the site and click its own "Log in / Sign in" link.
  if (!best && !fallback) {
    await vm.open(conn.url);
    await vm.sleep(2000);
    const els0 = parseSnapshot(await vm.snapshot());
    const link = els0.find((e) => /link|button/.test(e.role) && /^(log ?in|sign ?in|login|account|my account)\b/i.test(e.name) && !/sign ?up|register|create/i.test(e.name));
    if (link) {
      await vm.agentBrowser(['click', '@' + link.ref], 15000);
      await vm.sleep(2500);
      const els1 = parseSnapshot(await vm.snapshot());
      if (els1.some((e) => /textbox/.test(e.role))) {
        best = { url: await vm.getUrl(), title: await vm.getTitle(), els: els1 };
      }
    }
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
    } else if (/button|link/.test(e.role) && isSignInMethod(n)) {
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

/** Pull visible instruction text + any displayed codes from a full snapshot. */
function extractAuthText(snap) {
  const messages = [];
  const codes = [];
  for (const line of String(snap || '').split('\n')) {
    const m = line.match(/^\s*-\s+(heading|StaticText|paragraph|text|strong)\s+"((?:[^"\\]|\\.)+)"/);
    if (!m) continue;
    const t = m[2].trim();
    if (t.length < 2 || t.length > 200) continue;
    if (/(verify|verification|confirm|code|sent|enter the|authenticat|two-factor|2fa|one-?time|security|device|approve|tap the|select the|number|check your|we('| )?ve sent|passkey|recovery|can't access|didn'?t get)/i.test(t)) {
      if (!messages.includes(t)) messages.push(t);
    }
    // a prominent short number the site shows to match on a device (e.g. GitHub mobile)
    const numMatch = t.match(/\b(\d{2,3})\b/);
    if (numMatch && /(number|tap|select|confirm|match|shown|enter this)/i.test(t)) {
      if (!codes.includes(numMatch[1])) codes.push(numMatch[1]);
    }
  }
  return { messages: messages.slice(0, 5), codes: codes.slice(0, 2) };
}

/**
 * Read whatever auth step the site is CURRENTLY showing and describe it for the
 * chat: step type, the site's own instruction text, any number it displays to
 * match on a device, the exact input(s) to fill, and the action buttons.
 */
async function detectAuthStep(conn) {
  const url = await vm.getUrl();
  const title = await vm.getTitle();
  const interactive = await vm.snapshot({ interactive: true });
  const full = await vm.snapshot({ interactive: false, compact: true });
  const els = parseSnapshot(interactive);
  const { messages, codes } = extractAuthText(full);

  if (isAuthenticated(els, url, title)) {
    return { step: 'done', authenticated: true, url, title, messages, fields: [], buttons: [], codesShown: [] };
  }
  if (looksLikeSignup(els, title)) {
    return { step: 'signup', authenticated: false, message: 'This looks like a sign-up page; this tool only signs in.', fields: [], buttons: [], codesShown: codes };
  }

  const fields = [];
  const sso = [];
  for (const e of els) {
    const n = e.name.toLowerCase();
    if (/textbox|combobox/.test(e.role)) {
      let type = 'text';
      if (/verification|security|confirmation|one.?time|2fa|two.?factor|\bcode\b|passcode|digit|authenticator|token/.test(n)) type = 'otp';
      else if (/password|passcode|\bpin\b/.test(n)) type = 'password';
      else if (/e-?mail|courriel/.test(n)) type = 'email';
      else if (/phone|mobile|sms/.test(n)) type = 'tel';
      else if (/user ?name|user id|login|account|identifier|handle/.test(n)) type = 'username';
      fields.push({ ref: e.ref, id: e.ref, label: e.name || type, type, required: /required/i.test(e.attrs) });
    } else if (/button|link/.test(e.role) && isSignInMethod(n)) {
      sso.push({ ref: e.ref, label: e.name });
    }
  }
  const actionButtons = els
    .filter((e) => /button/.test(e.role) && /^(verify|confirm|continue|next|submit|log ?in|sign ?in|resend|send code|try another|use a|approve)/i.test(e.name))
    .map((e) => ({ ref: e.ref, label: e.name }));

  const hasPassword = fields.some((f) => f.type === 'password');
  const hasOtp = fields.some((f) => f.type === 'otp');
  const pushLike = !fields.length && (codes.length > 0 || /(check your|approve|open the|tap the|we('| )?ve sent|notification|authenticator app|confirm it'?s you)/i.test(messages.join(' ')));

  let step = 'other';
  if (hasPassword) step = 'credentials';
  else if (hasOtp) step = 'code';
  else if (pushLike) step = 'push';
  else if (fields.length) step = 'input';

  return {
    step,
    authenticated: false,
    url, title,
    messages,
    codesShown: codes,
    fields,
    ssoButtons: sso,
    buttons: actionButtons,
    hasPassword, hasOtp
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
    await vm.sleep(3500);
  }
  // Report whatever the site shows next (code input, number to match, push, etc.)
  const next = await detectAuthStep(conn);
  return { ok: true, submitted: Boolean(submit && form.submitRef), ...next, needsOtp: next.step === 'code' };
}

/** Click a named auth action (Verify / Resend / Approve) by ref, then re-read the step. */
async function clickAuthButton(conn, ref) {
  await vm.agentBrowser(['click', '@' + String(ref).replace(/[^a-zA-Z0-9]/g, '')], 15000);
  await vm.sleep(3000);
  return detectAuthStep(conn);
}

// ---------- natural-language → website resolution ----------

const BRANDS = {
  instagram: 'instagram.com', insta: 'instagram.com', ig: 'instagram.com',
  github: 'github.com', github: 'github.com',
  twitter: 'x.com', x: 'x.com',
  gmail: 'mail.google.com', googlemail: 'mail.google.com', google: 'google.com',
  outlook: 'outlook.office.com', hotmail: 'outlook.live.com',
  linkedin: 'linkedin.com', facebook: 'facebook.com', fb: 'facebook.com',
  reddit: 'reddit.com', youtube: 'youtube.com', yt: 'youtube.com',
  tiktok: 'tiktok.com', pinterest: 'pinterest.com', spotify: 'open.spotify.com',
  notion: 'notion.so', slack: 'slack.com', discord: 'discord.com',
  amazon: 'amazon.com', netflix: 'netflix.com', twitch: 'twitch.tv',
  whatsapp: 'web.whatsapp.com', telegram: 'web.telegram.org'
};

async function llmComplete(messages, timeoutMs = 20000) {
  const url = config.artbloomBaseUrl.replace(/\/$/, '') + '/chat/completions';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.artbloomApiKey}` },
      body: JSON.stringify({ model: config.artbloomModel, messages, temperature: 0, max_tokens: 60 }),
      signal: ctrl.signal
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`LLM ${r.status}`);
    return (JSON.parse(t).choices?.[0]?.message?.content || '').trim();
  } finally { clearTimeout(timer); }
}

/**
 * Turn a free-text request ("connect my instagram", "mcp for my school portal
 * example.edu") into a single website URL. Instant for known brands / explicit
 * domains; falls back to the LLM for anything else.
 */
async function resolveSiteUrl(text) {
  const raw = (text || '').trim();
  if (!raw) return { ok: false, reason: 'empty' };

  // 1. explicit URL / domain in the text
  const domainMatch = raw.match(/\b((?:[a-z0-9-]+\.)+[a-z]{2,})(\/[^\s]*)?/i);
  if (domainMatch && !/^(e\.g|i\.e)\./i.test(domainMatch[0])) {
    return { ok: true, url: 'https://' + domainMatch[1].replace(/^www\./i, ''), source: 'domain' };
  }
  if (raw.startsWith('@')) return { ok: true, url: `https://instagram.com/${raw.slice(1)}`, source: 'handle' };

  // 2. known brand keyword
  const words = raw.toLowerCase().match(/[a-z0-9]+/g) || [];
  for (const w of words) {
    if (BRANDS[w]) return { ok: true, url: 'https://' + BRANDS[w], source: 'brand', brand: w };
  }

  // 3. ask the fast model to name the site
  try {
    const out = await llmComplete([
      { role: 'system', content: 'You map a user request to the ONE website they want to connect or automate. Reply with ONLY the root URL as https://domain.tld and nothing else. If you truly cannot tell which site, reply exactly UNKNOWN.' },
      { role: 'user', content: raw }
    ]);
    const m = out.match(/https?:\/\/[^\s]+/i) || out.match(/\b((?:[a-z0-9-]+\.)+[a-z]{2,})/i);
    if (m && !/unknown/i.test(out)) {
      const u = m[0].startsWith('http') ? m[0] : 'https://' + m[0];
      return { ok: true, url: u.replace(/\/$/, ''), source: 'llm' };
    }
  } catch (_) {}

  return { ok: false, reason: 'unclear' };
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
  resolveSiteUrl,
  verifySession,
  detectLoginForm,
  detectAuthStep,
  clickAuthButton,
  fillLogin,
  runInstruction,
  parseSnapshot,
  isAuthenticated
};
