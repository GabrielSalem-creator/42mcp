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
const scraperEngine = require('./scraperEngine');
const { parseIntent } = require('./intentParser');

const IG_CLUSTERS = { mcgill: 'mcgillu', nasa: 'nasa', natgeo: 'natgeo' };

/** Instagram: use the dedicated DOM extractor for real post/story URLs (fast, precise). */
async function runInstagramInstruction(conn, instruction) {
  // Fail fast if Instagram isn't actually signed in on this connection.
  const login = await scraperEngine.verifyLogin('instagram').catch(() => ({ connected: false }));
  if (!login.connected) {
    return { ok: false, error: 'Instagram is not signed in on this connection. Open https://www.42mcp.tech, connect Instagram and sign in once, then retry. (No active Instagram session was found.)' };
  }

  const intent = parseIntent(instruction);
  let targets = (intent.targets || []).map((t) => t.replace(/^@/, ''));
  if (!targets.length) {
    const stop = new Set(['give', 'me', 'the', 'my', 'get', 'stories', 'story', 'urls', 'url', 'posts', 'post', 'of', 'from', 'and', 'all', 'latest', 'on', 'instagram']);
    const brand = (instruction.toLowerCase().match(/[a-z][a-z0-9_.]{2,}/g) || []).find((w) => !stop.has(w));
    if (brand) targets = [brand];
  }
  if (!targets.length) return null; // let the generic loop handle vague asks
  const wantStories = /stor(y|ies|ies')/i.test(instruction);

  const results = [];
  for (const raw of targets.slice(0, 2)) {
    const t = (IG_CLUSTERS[raw.toLowerCase()] || raw).replace(/^mcgill$/i, 'mcgillu');
    const prof = await scraperEngine.scrapeDirect({
      platform: 'instagram', target: t, depth: 12,
      dataTypes: ['text', 'images', 'videos', 'metrics']
    }).catch(() => null);
    if (!prof) continue;
    if (prof.requiresLogin) {
      return { ok: false, error: `Instagram isn't signed in on this connection. Open the site, sign in to Instagram, then retry.` };
    }
    let stories = [];
    if (wantStories) {
      const s = await scraperEngine.scrapeStoriesDirect({ target: t, maxStories: 20 }).catch(() => null);
      stories = (s && s.items || []).map((i) => ({ type: 'story', url: i.postUrl || i.mediaUrl, media: i.mediaUrl }));
    }
    const posts = (prof.items || []).map((i) => ({
      url: i.postUrl, type: i.type, caption: (i.caption || '').slice(0, 120), media: i.mediaUrl
    })).filter((p) => p.url);
    results.push({ account: t, profile: prof.profile && prof.profile.username, postCount: posts.length, posts, stories });
  }
  if (!results.length) return null;
  const allPosts = results.flatMap((r) => r.posts);
  const allStories = results.flatMap((r) => r.stories);
  connections.recordRun(conn.id, { instruction, risk: 'read', steps: results.length });
  return {
    ok: true, risk: 'read',
    result: {
      accounts: results.map((r) => r.account),
      totalPosts: allPosts.length,
      totalStories: allStories.length,
      postUrls: allPosts.map((p) => p.url),
      storyUrls: allStories.map((s) => s.url),
      posts: allPosts,
      stories: allStories
    }
  };
}

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
  // For platforms with a known auth cookie, trust the cookie, not page heuristics.
  if (/instagram\.com/i.test(conn.domain)) {
    const login = await scraperEngine.verifyLogin('instagram').catch(() => ({ connected: false }));
    connections.setStatus(conn.id, login.connected ? 'connected' : 'needs_auth');
    return { authenticated: !!login.connected, url: conn.url, title: 'instagram' };
  }
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
  const SKIP = /(language|country|region|locale|timezone|currency|search|cookie|newsletter|captcha|change language)/i;
  for (const e of els) {
    const n = e.name.toLowerCase();
    if (/textbox|combobox/.test(e.role)) {
      if (SKIP.test(n)) continue;
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
 * LLM reads the full page (accessibility tree ≈ meaningful HTML) and decides what
 * the current sign-in step is and exactly what to show — works for ANY site.
 */
const AUTH_ANALYSIS_PROMPT = `You are a precise web sign-in analyst. You are given the ACCESSIBILITY TREE of the page that is open RIGHT NOW in a browser where the account owner is trying to SIGN IN to their OWN account. Each interactive element has a ref like [ref=e12].

Your job: report the EXACT current state of this one page and EXACTLY what the user must provide at this instant — nothing more, nothing less. The sign-in is multi-step: only describe THIS page. Do not ask for a password if the page only asks for an email. Do not invent fields that are not on the page.

Decide the state:
- "done": this is a signed-in / logged-in view. Signals: a Sign out / Log out control, an account menu or avatar, a dashboard / inbox / feed / profile, and NO login form. If you see "Sign in" / "Log in" / "Sign up" call-to-actions, it is NOT done.
- "signup": this is a registration / create-account page (it asks to CREATE an account). Set signup=true. We never automate sign-up.
- "credentials": the page asks for identity and/or secret. This includes: email-only first step (e.g. Google, Microsoft), username+password, phone+password, password-only second step.
- "code": the page asks for a verification / one-time / 2FA / authenticator / SMS / email code. Put the input(s) in fields with type "otp".
- "push": the page is waiting for the user to approve on another device, OR it DISPLAYS a number for the user to tap/match on their phone (e.g. GitHub Mobile, Microsoft Authenticator). There is usually no input to type. Put any displayed number(s) in codesShown.
- "input": any other step that needs typed input (security question, recovery email, etc.).

Field rules (very important):
- Include in "fields" ONLY inputs the user must TYPE on THIS page right now.
- NEVER include: language selector, country/region, currency, timezone, search box, cookie/consent controls, newsletter/marketing, promo/coupon, or anything decorative.
- Use the element's own visible label verbatim.
- type is one of: "username" (user id / handle / "username or email"), "email", "password", "otp" (any verification/one-time code), "tel" (phone), "text" (anything else).
- Report fields in the ON-SCREEN order, top to bottom.

Also report:
- "instruction": one short sentence quoting what the site is telling the user to do now (e.g. "Enter the 6-digit code we sent to your phone").
- "buttons": the primary action controls (Sign in / Log in / Continue / Next / Submit / Verify / Confirm / Resend / Approve).
- "methods": alternative sign-in methods the page offers (Continue with Google/Apple/Microsoft/GitHub/Facebook, passkey, email magic link, SSO). NEVER include Sign up / Create account here.
- "codesShown": any SHORT number/code the PAGE ITSELF DISPLAYS for the user to confirm on a device. Do NOT put the user's input here.

Return STRICT JSON ONLY — no markdown, no commentary:
{"authenticated":bool,"signup":bool,"step":"credentials|code|push|input|done","instruction":"...","fields":[{"ref":"e#","label":"...","type":"username|email|password|otp|tel|text"}],"buttons":[{"ref":"e#","label":"..."}],"methods":[{"ref":"e#","label":"..."}],"codesShown":["..."]}`;

async function analyzeAuthWithLLM(snapshot, url, title) {
  const user = `URL: ${url}\nPAGE TITLE: ${title}\n\nACCESSIBILITY TREE (the current page):\n${String(snapshot).slice(0, 6500)}`;
  const out = await analysisComplete(AUTH_ANALYSIS_PROMPT, user, 30000, 700);
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return null;
  return JSON.parse(m[0]);
}

/**
 * Read whatever auth step the site is CURRENTLY showing and describe it for the
 * chat. Uses the LLM to understand the whole page, with a heuristic fallback.
 */
async function detectAuthStep(conn) {
  const url = await vm.getUrl();
  const title = await vm.getTitle();
  const interactive = await vm.snapshot({ interactive: true });

  // Primary: the model reads the current page and decides (one snapshot, one call).
  if (config.analysisCliBin || config.artbloomApiKey) {
    try {
      const j = await analyzeAuthWithLLM(interactive, url, title);
      if (j && (j.authenticated || j.signup || Array.isArray(j.fields))) {
        const fields = (j.fields || [])
          .filter((f) => f && f.ref)
          .map((f) => ({ ref: f.ref, id: f.ref, label: f.label || f.type || 'Field', type: f.type || 'text' }));
        const step = j.authenticated ? 'done' : (j.signup ? 'signup' : (j.step || (fields.length ? 'credentials' : 'other')));
        return {
          step,
          authenticated: !!j.authenticated,
          url, title,
          messages: j.instruction ? [j.instruction] : [],
          codesShown: j.codesShown || [],
          fields,
          ssoButtons: (j.methods || []).filter((m) => m && m.ref),
          buttons: (j.buttons || []).filter((b) => b && b.ref),
          hasPassword: fields.some((f) => f.type === 'password'),
          hasOtp: fields.some((f) => f.type === 'otp'),
          analyzedBy: 'llm'
        };
      }
    } catch (e) { /* fall through to heuristic */ }
  }

  // Fallback heuristic — only now take the extra snapshot for visible text.
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
  // inputs that are never credentials — don't show them as login fields
  const IRRELEVANT = /(language|country|region|locale|timezone|time zone|currency|search|cookie|newsletter|subscribe|promo|coupon|captcha|change language)/i;
  for (const e of els) {
    const n = e.name.toLowerCase();
    if (/textbox|combobox/.test(e.role)) {
      if (IRRELEVANT.test(n)) continue;
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

/**
 * Fill the owner's own values into the fields they were shown (keyed by element
 * ref from the last auth-step; still valid because the VM page hasn't changed),
 * submit, and report the next step. Works for any site. Values are not stored.
 */
async function fillLogin(conn, input = [], submit = true) {
  // Accept an ordered [{ref,value}] list (preferred) or a {ref:value} object.
  const pairs = Array.isArray(input)
    ? input.map((f) => [f.ref, f.value])
    : Object.entries(input || {});
  let filled = 0;
  for (const [key, val] of pairs) {
    if (val == null || val === '') continue;
    const ref = String(key).replace(/[^a-zA-Z0-9]/g, '');
    if (!/^e\d+$/.test(ref)) continue;
    await vm.agentBrowser(['fill', '@' + ref, String(val)], 15000);
    await vm.sleep(150);
    filled++;
  }
  if (submit) {
    // Click the most likely submit/continue/verify control on the CURRENT page.
    const els = parseSnapshot(await vm.snapshot());
    const btn = els.find((e) => /button/.test(e.role) && /^(log ?in|sign ?in|continue|next|submit|verify|confirm|done)\b/i.test(e.name));
    if (btn) await vm.agentBrowser(['click', '@' + btn.ref], 15000);
    else await vm.agentBrowser(['press', 'Enter'], 12000);
    await vm.sleep(3500);
  }
  const next = await detectAuthStep(conn);
  return { ok: true, submitted: Boolean(submit), filled, ...next, needsOtp: next.step === 'code' };
}

/**
 * Navigate to the sign-in page and analyze it with the model — stops as soon as
 * a usable sign-in screen (fields or methods), an authenticated view, or a
 * sign-up page is found. Fewer round-trips than probing every URL.
 */
async function openLoginAndAnalyze(conn) {
  const tries = [conn.loginUrl, conn.url, `https://${conn.domain}/login`, `https://${conn.domain}/signin`, `https://${conn.domain}/session/new`, `https://${conn.domain}/auth/login`].filter(Boolean);
  const seen = new Set();
  let last = null;
  for (const u of tries) {
    if (seen.has(u)) continue; seen.add(u);
    await vm.open(u); await vm.sleep(1800);
    const step = await detectAuthStep(conn);
    last = step;
    const usable = step.authenticated || step.step === 'signup' ||
      (step.fields && step.fields.length) || (step.ssoButtons && step.ssoButtons.length);
    if (usable) { connections.update(conn.id, { loginUrl: step.url }); return step; }
  }
  return last || { step: 'other', url: conn.url, fields: [], ssoButtons: [], buttons: [], messages: [], codesShown: [] };
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

const boxdClient = require('./boxdClient');

/** Run a prompt through a configured local reasoning CLI on the VM (reads stdin). */
async function cliComplete(prompt, timeoutMs = 30000) {
  const bin = config.analysisCliBin;
  if (!bin) throw new Error('no analysis CLI configured');
  const b64 = Buffer.from(String(prompt), 'utf8').toString('base64');
  const cmd = `export DISPLAY=${config.display}; echo ${b64} | base64 -d | ${bin} -p --output-format text 2>/dev/null`;
  const r = await boxdClient.exec(cmd, undefined, timeoutMs);
  return (r.stdout || '').trim();
}

/**
 * Best available completion for page-understanding tasks: a configured local
 * reasoning CLI first (highest quality), else the hosted model. Returns raw text.
 */
async function analysisComplete(system, user, timeoutMs = 30000, maxTokens = 700) {
  if (config.analysisCliBin) {
    try {
      const out = await cliComplete(`${system}\n\n${user}`, timeoutMs);
      if (out && /[\{\[]/.test(out)) return out;
    } catch (_) { /* fall back */ }
  }
  return llmComplete([{ role: 'system', content: system }, { role: 'user', content: user }], Math.min(timeoutMs, 25000), maxTokens);
}

async function llmComplete(messages, timeoutMs = 20000, maxTokens = 60) {
  const url = config.artbloomBaseUrl.replace(/\/$/, '') + '/chat/completions';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.artbloomApiKey}` },
      body: JSON.stringify({ model: config.artbloomModel, messages, temperature: 0, max_tokens: maxTokens }),
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
// Terse action-loop prompt for the local reasoning CLI controlling the browser.
const CLI_CONTROL_PROMPT = (domain) => `You control a logged-in Chrome browser to do ONE task on ${domain}. Reply with ONLY ONE JSON action per turn, no prose:
{"action":"navigate","url":"..."}
{"action":"click","ref":"eN"}
{"action":"fill","ref":"eN","text":"..."}
{"action":"press","key":"Enter"}
{"action":"scroll","direction":"down"}
{"action":"read"}            // get page text when you need details
{"action":"finish","result":<the answer as JSON>,"risk":"read|write"}
Rules: refs (eN) come ONLY from the CURRENT PAGE shown. Use the fewest steps. Do not sign up or change account settings. For state-changing actions (send/post/delete/buy) set risk "write". When you have the answer, finish with the full result as structured JSON. Be concise.`;

/** The configured reasoning CLI drives the browser step by step. */
async function runInstructionWithCli(conn, instruction, { maxSteps = 10 } = {}) {
  await vm.open(conn.url); await vm.sleep(1500);
  const sys = CLI_CONTROL_PROMPT(conn.domain);
  const steps = [];
  let last = '';
  for (let i = 0; i < maxSteps; i++) {
    const page = trimmed(await vm.snapshot());
    const prompt = `${sys}\n\nTASK: ${instruction}\nSTEP ${i + 1}${last ? ` (last: ${last})` : ''}\nCURRENT PAGE:\n${page}\n\nNext action JSON:`;
    let out;
    try { out = await cliComplete(prompt, 35000); }
    catch (e) { return { ok: false, error: 'controller error: ' + e.message, steps }; }
    const m = out.match(/\{[\s\S]*\}/);
    if (!m) { last = 'no action parsed'; continue; }
    let a;
    try { a = JSON.parse(m[0]); } catch (_) { last = 'bad json'; continue; }
    if (a.action === 'finish' || a.done || a.result !== undefined) {
      connections.recordRun(conn.id, { instruction, risk: a.risk || 'read', steps: steps.length });
      return { ok: true, result: a.result ?? a.text ?? 'Done.', risk: a.risk || 'read', steps };
    }
    try { await runAction({ action: a.action, url: a.url, ref: a.ref, text: a.text, key: a.key, direction: a.direction || a.dir }); }
    catch (e) { last = 'error: ' + e.message; continue; }
    steps.push({ action: a.action, ref: a.ref, url: a.url });
    last = a.action + (a.ref ? ' @' + a.ref : '') + (a.url ? ' ' + a.url : '');
  }
  return { ok: true, result: 'Reached step limit.', risk: 'read', steps, partial: true };
}

async function runInstruction(conn, instruction, { maxSteps = 12 } = {}) {
  // Instagram → dedicated DOM extractor (real post/story URLs, fast).
  if (/instagram\.com/i.test(conn.domain)) {
    try {
      const ig = await runInstagramInstruction(conn, instruction);
      if (ig) return ig;
    } catch (_) { /* fall through to generic */ }
  }
  // Prefer the configured local reasoning CLI as the browser controller.
  if (config.analysisCliBin) {
    try {
      const out = await runInstructionWithCli(conn, instruction, { maxSteps: 10 });
      if (out && (out.ok || out.error)) return out;
    } catch (_) { /* fall back to hosted model loop */ }
  }
  if (!config.artbloomApiKey) {
    return { ok: false, error: 'No planner LLM configured.' };
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
  openLoginAndAnalyze,
  detectAuthStep,
  clickAuthButton,
  fillLogin,
  runInstruction,
  parseSnapshot,
  isAuthenticated
};
