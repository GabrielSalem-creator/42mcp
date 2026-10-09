'use strict';

const state = {
  conn: null,
  integration: null,
  mode: 'ask_site',      // ask_site | await_login | ready
  busy: false,
  liveTimer: null,
  inputInFlight: false
};

const log = () => document.getElementById('log');
const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', () => {
  bindComposer();
  $('newChatBtn').addEventListener('click', newConnection);
  $('accountsBtn').addEventListener('click', openAccounts);
  $('accountsClose').addEventListener('click', closeAccounts);
  $('accountsAdd').addEventListener('click', () => { closeAccounts(); newConnection(); });
  $('accountsSheet').addEventListener('click', (e) => { if (e.target === $('accountsSheet')) closeAccounts(); });
  fetchStatus();
  setInterval(fetchStatus, 20000);
  boot();
  setupViewport();
});

// Keep the composer above the iOS keyboard by sizing to the visual viewport.
function setupViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const fit = () => { document.body.style.height = vv.height + 'px'; };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  fit();
}

/* ---------------- accounts panel ---------------- */
async function openAccounts() {
  $('accountsSheet').hidden = false;
  const list = $('acctList');
  list.innerHTML = '<p class="acct__empty">Loading…</p>';
  try {
    const d = await api('/api/connections');
    const conns = d.connections || [];
    $('accountsSub').textContent = conns.length ? "Sites you're signed in to. Open one to use it, or log out." : "You haven't connected any sites yet.";
    if (!conns.length) { list.innerHTML = '<p class="acct__empty">No accounts yet. Connect a site below.</p>'; return; }
    list.innerHTML = conns.map((c) => {
      const active = c.id === d.activeId;
      const connected = c.status === 'connected';
      const statusTxt = connected ? 'Signed in' : 'Needs sign-in';
      const dotCls = connected ? 'is-ok' : 'is-warn';
      return `<div class="acct${active ? ' is-active' : ''}" data-id="${esc(c.id)}">
        <div class="acct__fav"><img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(c.domain)}&sz=64" onerror="this.parentNode.textContent='🌐'"></div>
        <div class="acct__info">
          <div class="acct__domain">${esc(c.domain)}${active ? ' · <span style="color:var(--brand-2)">active</span>' : ''}</div>
          <div class="acct__meta"><span class="dot ${dotCls}"></span>${statusTxt}${c.tools && c.tools.length ? ` · ${c.tools.length} tool${c.tools.length > 1 ? 's' : ''}` : ''}</div>
        </div>
        <div class="acct__actions">
          <button class="acct__btn" data-act="open">Open</button>
          <button class="acct__btn acct__btn--danger" data-act="logout">Log out</button>
        </div>
      </div>`;
    }).join('');
    list.querySelectorAll('.acct').forEach((row) => {
      const id = row.dataset.id;
      row.querySelector('[data-act="open"]').addEventListener('click', () => switchAccount(id));
      row.querySelector('[data-act="logout"]').addEventListener('click', () => logoutAccount(id, row));
    });
  } catch (e) { list.innerHTML = `<p class="acct__empty">${esc(e.message)}</p>`; }
}
function closeAccounts() { $('accountsSheet').hidden = true; }

async function switchAccount(id) {
  try {
    const d = await api(`/api/connections/${id}/activate`, { method: 'POST', body: '{}' });
    state.conn = d.connection; state.integration = d.integration;
    closeAccounts();
    log().innerHTML = '';
    if (d.connection.status === 'connected') {
      state.mode = 'ready';
      addAI(`Switched to <b>${esc(d.connection.domain)}</b>. Ask me anything and I'll run it there.`);
      showCreds(false);
    } else { state.mode = 'await_login'; addAI(`Switched to <b>${esc(d.connection.domain)}</b> — let's finish signing in.`); promptLogin(); }
  } catch (e) { toast(e.message); }
}

async function logoutAccount(id, row) {
  row.style.opacity = '.5';
  try {
    await api(`/api/connections/${id}/logout`, { method: 'POST', body: '{}' });
    toast('Logged out');
    if (state.conn && state.conn.id === id) { state.conn = null; state.integration = null; log().innerHTML = ''; greet(); }
    openAccounts();
  } catch (e) { row.style.opacity = '1'; toast(e.message); }
}

/* ---------------- api ---------------- */
function api(path, opts) {
  return fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts)).then(async (r) => {
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  });
}
function toast(m) { const t = $('toast'); t.textContent = m; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2600); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function scrollDown() { const c = document.getElementById('chat'); c.scrollTop = c.scrollHeight; }
function normalizeUrl(t) {
  t = (t || '').trim();
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return t;
  if (t.startsWith('@')) return `https://instagram.com/${t.slice(1)}`;
  if (/\s/.test(t)) return '';
  if (t.includes('.')) return `https://${t}`;
  return `https://${t}.com`;
}
function looksLikeSite(t) { t = (t || '').trim(); return !/\s/.test(t) && (t.includes('.') || t.startsWith('@')); }

/* ---------------- status ---------------- */
async function fetchStatus() {
  try {
    const d = await api('/api/status');
    const running = (d.vmStatus || '').toLowerCase() === 'running';
    $('vmDot').className = 'dot ' + (running ? 'is-ok' : 'is-warn');
    $('vmStatusText').textContent = running ? 'online' : (d.vmStatus || '…');
  } catch (_) { $('vmDot').className = 'dot is-err'; $('vmStatusText').textContent = 'offline'; }
}

/* ---------------- boot ---------------- */
async function boot() {
  try {
    const d = await api('/api/connections');
    if (d.active) {
      state.conn = d.active; state.integration = d.integration;
      if (d.active.status === 'connected') {
        state.mode = 'ready';
        addAI(`Welcome back — you're connected to <b>${esc(d.active.domain)}</b>. Ask me anything, like “get my latest items”, and I'll run it on the live site.`);
        showCreds(false);
      } else {
        state.mode = 'await_login';
        addAI(`You started connecting <b>${esc(d.active.domain)}</b> but aren't signed in yet. Want to finish?`);
        promptLogin();
      }
      return;
    }
  } catch (_) {}
  greet();
}

function greet() {
  state.mode = 'ask_site';
  addAI("Hey 👋 I turn any website into an MCP server and API.\n\nWhich site do you want to connect? Just type one, like <b>instagram.com</b>.", {
    chips: ['instagram.com', 'github.com', 'x.com']
  });
}

/* ---------------- message builders ---------------- */
function addUser(text) {
  const row = document.createElement('div');
  row.className = 'msg msg--user';
  row.innerHTML = `<div class="bubble">${esc(text)}</div>`;
  log().appendChild(row); scrollDown();
}
function addAI(html, opts = {}) {
  const row = document.createElement('div');
  row.className = 'msg msg--ai';
  const chips = (opts.chips || []).map((c) => `<button class="qchip" data-chip="${esc(c)}">${esc(c)}</button>`).join('');
  row.innerHTML = `<div class="msg__av">42</div><div class="bubble${opts.card ? ' bubble--card' : ''}">${html}${chips ? `<div class="qchips">${chips}</div>` : ''}</div>`;
  log().appendChild(row);
  row.querySelectorAll('.qchip').forEach((b) => b.addEventListener('click', () => { startSite(b.dataset.chip); }));
  scrollDown();
  return row.querySelector('.bubble');
}
function addTyping() {
  const row = document.createElement('div');
  row.className = 'msg msg--ai';
  row.id = 'typingRow';
  row.innerHTML = `<div class="msg__av">42</div><div class="bubble"><span class="typing"><span></span><span></span><span></span></span></div>`;
  log().appendChild(row); scrollDown();
}
function removeTyping() { const t = $('typingRow'); if (t) t.remove(); }

/* ---------------- composer ---------------- */
function bindComposer() {
  const input = $('input');
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit(); } });
  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || state.busy) return;
    input.value = ''; input.style.height = 'auto';
    handleInput(text);
  });
}

function setBusy(b) {
  state.busy = b;
  $('sendBtn').disabled = b;
}

async function handleInput(text) {
  addUser(text);
  if (state.mode === 'ready') { runInstruction(text); return; }
  // ask_site / await_login: a clear domain starts immediately…
  if (looksLikeSite(text)) { startSite(text); return; }
  // …otherwise understand natural language ("connect my instagram", "mcp for my school portal")
  setBusy(true); addTyping();
  try {
    const r = await api('/api/resolve-site', { method: 'POST', body: JSON.stringify({ text }) });
    removeTyping();
    if (r.ok && r.url) {
      const dom = r.url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
      addAI(`Got it — connecting <b>${esc(dom)}</b>.`);
      startSite(r.url);
    } else if (state.mode === 'await_login') {
      addAI("Finish signing in above, or name another website to switch.");
    } else {
      addAI("Which website do you mean? Tell me the site or its address — e.g. “connect my Instagram” or <b>portal.myschool.edu</b>.");
    }
  } catch (e) { removeTyping(); addAI("I couldn't work out which site — try naming it, like <b>instagram.com</b>."); }
  finally { setBusy(false); }
}

/* ---------------- connect a site ---------------- */
async function startSite(raw) {
  const url = normalizeUrl(raw);
  if (!url) { addAI("Type a single website address, like <b>instagram.com</b> (no spaces)."); return; }
  setBusy(true); addTyping();
  try {
    const d = await api('/api/connections', { method: 'POST', body: JSON.stringify({ url }) });
    state.conn = d.connection; state.integration = d.integration;
    removeTyping();
    addAI(`Opening <b>${esc(state.conn.domain)}</b> on your private cloud browser…`);
    addTyping();
    const v = await api(`/api/connections/${state.conn.id}/verify`, { method: 'POST', body: '{}' });
    removeTyping();
    if (v.authenticated) {
      state.conn.status = 'connected'; state.mode = 'ready';
      addAI(`You're already signed in to <b>${esc(state.conn.domain)}</b>. 🎉`);
      showCreds(true);
    } else {
      state.mode = 'await_login';
      addAI(`To use <b>${esc(state.conn.domain)}</b> I need you to sign in once. This stays in your own private browser — I never store your password.`);
      promptLogin();
    }
  } catch (e) { removeTyping(); addAI(`Couldn't start that: ${esc(e.message)}`); }
  finally { setBusy(false); }
}

/* ---------------- login (in chat) ---------------- */
async function promptLogin() {
  setBusy(true); addTyping();
  try {
    const step = await api(`/api/connections/${state.conn.id}/open-login`, { method: 'POST', body: '{}' });
    removeTyping();
    renderAuthStep(step);
  } catch (e) { removeTyping(); addAI(`I couldn't read the sign-in page: ${esc(e.message)}`); }
  finally { setBusy(false); }
}

const STEP_TITLE = {
  credentials: 'Sign in',
  code: 'Enter your verification code',
  push: 'Approve on your device',
  input: 'Continue signing in',
  other: 'Sign in',
  signup: 'Sign in'
};

/** Render whatever the site is currently showing, in chat. */
function renderAuthStep(step) {
  if (step.authenticated || step.step === 'done') { onConnected(); return; }
  const bubble = addAI('', { card: true });

  const fields = step.fields || [];
  const sso = step.ssoButtons || [];
  const buttons = step.buttons || [];
  const messages = step.messages || [];
  const codes = step.codesShown || [];

  const title = STEP_TITLE[step.step] || 'Sign in';
  const msgHtml = messages.length ? `<p class="lform__msg">${messages.map(esc).join('<br>')}</p>` : '';
  const codeHtml = codes.length
    ? `<div class="numcard"><span class="numcard__hint">On your phone, tap / confirm</span><span class="numcard__num">${codes.map(esc).join(' · ')}</span></div>` : '';
  const fieldsHtml = fields.map((f) => {
    const type = f.type === 'password' ? 'password' : f.type === 'email' ? 'email' : 'text';
    const otp = f.type === 'otp';
    return `<div class="lfield${otp ? ' lfield--otp' : ''}"><label>${esc(f.label)}</label><input data-fid="${esc(f.id)}" type="${type}" ${otp ? 'inputmode="numeric" maxlength="8"' : ''} autocomplete="off"></div>`;
  }).join('');
  const actionHtml = buttons.filter((b) => !/^(sign ?in|log ?in|continue|next|submit|verify|confirm)$/i.test(b.label) || !fields.length)
    .map((b) => `<button type="button" class="btn btn--ghost btn--sm actbtn" data-ref="${esc(b.ref)}">${esc(b.label)}</button>`).join('');
  const ssoHtml = sso.map((s) => `<button class="btn btn--ghost btn--block sso__btn" data-ref="${esc(s.ref)}">${esc(s.label)}</button>`).join('');

  bubble.innerHTML = `
    <p class="card-title">${esc(title)} · ${esc(state.conn.domain)}</p>
    ${msgHtml}${codeHtml}
    ${fields.length ? `<form class="lform">${fieldsHtml}
      <div class="lform__actions"><button type="submit" class="btn">${step.step === 'code' ? 'Verify' : 'Continue'}</button><button type="button" class="btn btn--ghost" data-act="screen">Live screen</button></div>
      <p class="lform__note">🔒 Goes straight into your browser. Never stored.</p></form>`
      : `<div class="lform__actions">
          ${step.step === 'push' ? '<button type="button" class="btn checkbtn">I approved it</button>' : ''}
          <button type="button" class="btn btn--ghost" data-act="screen">${step.step === 'push' ? 'Show live screen' : 'Sign in on the live screen'}</button>
        </div>`}
    ${actionHtml ? `<div class="lform__actions">${actionHtml}</div>` : ''}
    ${ssoHtml ? `<div class="sso">${ssoHtml}</div>` : ''}`;

  const formEl = bubble.querySelector('.lform');
  if (formEl) formEl.addEventListener('submit', (e) => { e.preventDefault(); submitLogin(formEl); });
  bubble.querySelectorAll('[data-act="screen"]').forEach((b) => b.addEventListener('click', () => embedLiveScreen(bubble)));
  bubble.querySelectorAll('.sso__btn').forEach((b) => b.addEventListener('click', () => ssoClick(b.dataset.ref)));
  bubble.querySelectorAll('.actbtn').forEach((b) => b.addEventListener('click', () => authButton(b.dataset.ref)));
  bubble.querySelectorAll('.checkbtn').forEach((b) => b.addEventListener('click', recheckAuth));
  if (step.step === 'push') startPushPoll();
}

async function submitLogin(formEl) {
  const values = {};
  formEl.querySelectorAll('input[data-fid]').forEach((i) => { if (i.value) values[i.dataset.fid] = i.value; });
  const btn = formEl.querySelector('button[type="submit"]'); if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
  addTyping();
  try {
    const d = await api(`/api/connections/${state.conn.id}/login`, { method: 'POST', body: JSON.stringify({ values, submit: true }) });
    removeTyping();
    if (d.authenticated) { onConnected(); return; }
    renderAuthStep(d);
  } catch (e) { removeTyping(); addAI(`Sign-in failed: ${esc(e.message)}`); }
}

async function authButton(ref) {
  addTyping();
  try {
    const d = await api(`/api/connections/${state.conn.id}/auth-button`, { method: 'POST', body: JSON.stringify({ ref }) });
    removeTyping();
    if (d.authenticated) onConnected(); else renderAuthStep(d);
  } catch (e) { removeTyping(); addAI(esc(e.message)); }
}

async function recheckAuth() {
  addTyping();
  try {
    const d = await api(`/api/connections/${state.conn.id}/auth-step`, { method: 'POST', body: '{}' });
    removeTyping();
    if (d.authenticated) onConnected(); else renderAuthStep(d);
  } catch (e) { removeTyping(); addAI(esc(e.message)); }
}

let pushPollTimer = null;
function startPushPoll() {
  stopPushPoll();
  let n = 0;
  pushPollTimer = setInterval(async () => {
    if (++n > 20) return stopPushPoll();
    try { const d = await api(`/api/connections/${state.conn.id}/auth-step`, { method: 'POST', body: '{}' }); if (d.authenticated) { stopPushPoll(); onConnected(); } } catch (_) {}
  }, 4000);
}
function stopPushPoll() { if (pushPollTimer) { clearInterval(pushPollTimer); pushPollTimer = null; } }

async function ssoClick(ref) {
  addTyping();
  try { await api('/api/browser/input', { method: 'POST', body: JSON.stringify({ action: 'click', ref }) }); } catch (_) {}
  removeTyping();
  const bubble = addAI('Continue with the provider on the live screen, then tap “I’m signed in”.', { card: true });
  embedLiveScreen(bubble, true);
}

function onConnected() {
  state.conn.status = 'connected'; state.mode = 'ready';
  stopLive();
  addAI(`Signed in to <b>${esc(state.conn.domain)}</b>. 🎉`);
  showCreds(true);
}

/* ---------------- live screen embedded in chat ---------------- */
function embedLiveScreen(bubble, withConfirm) {
  if (bubble.querySelector('.live')) return;
  const div = document.createElement('div');
  div.className = 'live';
  div.innerHTML = `
    <img class="live__img" alt="live browser">
    <div class="live__row"><input class="live__type" placeholder="Type into the page…"><button class="btn btn--sm live__enter">↵</button><button class="btn btn--sm btn--ghost live__done">I’m signed in</button></div>
    <p class="live__hint">Tap the picture to click. Sign in here, then tap “I’m signed in”.</p>`;
  bubble.appendChild(div);
  const img = div.querySelector('.live__img');
  img.addEventListener('click', (e) => liveClick(e, img));
  div.querySelector('.live__enter').addEventListener('click', () => sendLiveInput({ action: 'key', key: 'Return' }));
  div.querySelector('.live__type').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = e.target.value; e.target.value = ''; if (v) sendLiveInput({ action: 'type', text: v }); } });
  div.querySelector('.live__done').addEventListener('click', verifyAfterManual);
  refreshLive(img);
  stopLive();
  state.liveTimer = setInterval(() => refreshLive(img), 4000);
  scrollDown();
}
function stopLive() { if (state.liveTimer) { clearInterval(state.liveTimer); state.liveTimer = null; } }
async function refreshLive(img) {
  try { const d = await api('/api/browser/screenshot', { method: 'POST', body: '{}' }); if (d.screenshot) img.src = `data:image/jpeg;base64,${d.screenshot}`; } catch (_) {}
}
async function liveClick(e, img) {
  const r = img.getBoundingClientRect();
  const x = Math.round((e.clientX - r.left) / r.width * img.naturalWidth);
  const y = Math.round((e.clientY - r.top) / r.height * img.naturalHeight);
  if (!isFinite(x)) return;
  await sendLiveInput({ action: 'click', x, y });
}
async function sendLiveInput(body) {
  if (state.inputInFlight) return; state.inputInFlight = true;
  try { const d = await api('/api/browser/input', { method: 'POST', body: JSON.stringify(body) }); const img = document.querySelector('.live__img'); if (img && d.screenshot) img.src = `data:image/jpeg;base64,${d.screenshot}`; }
  catch (_) {} finally { state.inputInFlight = false; }
}
async function verifyAfterManual() {
  addTyping();
  try {
    const v = await api(`/api/connections/${state.conn.id}/verify`, { method: 'POST', body: '{}' });
    removeTyping();
    if (v.authenticated) onConnected();
    else addAI("Not signed in yet — finish on the live screen, then tap “I’m signed in” again.");
  } catch (e) { removeTyping(); addAI(esc(e.message)); }
}

/* ---------------- creds in chat ---------------- */
function showCreds(celebrate) {
  const i = state.integration; if (!i) return;
  const bubble = addAI('', { card: true });
  bubble.innerHTML = `
    <p class="card-title">${celebrate ? '🚀 ' : ''}Your MCP for ${esc(state.conn.domain)} is ready</p>
    <div class="cred">
      <div class="cred__row"><label>MCP URL</label><div class="cred__val"><code>${esc(i.mcpUrl)}</code><button class="cred__copy" data-c="${esc(i.mcpUrl)}">Copy</button></div></div>
      <div class="cred__row"><label>REST endpoint</label><div class="cred__val"><code>${esc(i.restUrl)}</code><button class="cred__copy" data-c="${esc(i.restUrl)}">Copy</button></div></div>
      <div class="cred__row"><label>API key</label><div class="cred__val"><code>${esc(i.apiKey)}</code><button class="cred__copy" data-c="${esc(i.apiKey)}">Copy</button></div></div>
    </div>`;
  bubble.querySelectorAll('.cred__copy').forEach((b) => b.addEventListener('click', () => { navigator.clipboard.writeText(b.dataset.c).then(() => toast('Copied')).catch(() => toast('Copy failed')); }));
  addAI("Now just tell me what you want — e.g. “get my latest 10 items”, “show unread messages” — and I'll do it on the live site and reply here.");
}

/* ---------------- run instruction ---------------- */
async function runInstruction(text) {
  setBusy(true); addTyping();
  try {
    const d = await api(`/api/connections/${state.conn.id}/run`, { method: 'POST', body: JSON.stringify({ instruction: text }) });
    removeTyping();
    if (!d.ok) { addAI(`I couldn't finish that: ${esc(d.error || 'unknown error')}`); return; }
    if (typeof d.result === 'string') addAI(esc(d.result));
    else {
      const bubble = addAI(`Done${d.risk === 'write' ? ' — this changed something on the site.' : '.'}`, { card: true });
      const pre = document.createElement('pre'); pre.className = 'jsonout'; pre.textContent = JSON.stringify(d.result, null, 2);
      bubble.appendChild(pre); scrollDown();
    }
  } catch (e) { removeTyping(); addAI(`Error: ${esc(e.message)}`); }
  finally { setBusy(false); }
}

/* ---------------- new connection ---------------- */
async function newConnection() {
  stopLive();
  if (state.conn) { try { await api(`/api/connections/${state.conn.id}`, { method: 'DELETE' }); } catch (_) {} }
  state.conn = null; state.integration = null;
  log().innerHTML = '';
  greet();
}
