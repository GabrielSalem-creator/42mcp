'use strict';

const state = {
  conn: null,
  integration: null,
  desktopUrl: '',
  ws: null,
  inputInFlight: false,
  scrollAccum: 0,
  scrollTimer: null,
  loginForm: null,
  screenTimer: null
};

document.addEventListener('DOMContentLoaded', () => {
  bindHero();
  bindScreen();
  bindTabs();
  bindConnActions();
  bindRunForm();
  bindLoginModal();
  bindCopy();
  initWebSocket();
  fetchStatus();
  loadActiveConnection();
  setInterval(fetchStatus, 20000);
});

/* ------------------------------- helpers ------------------------------- */
function $(id) { return document.getElementById(id); }
function api(path, opts) {
  return fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts)).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  });
}
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2600);
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function normalizeUrl(t) {
  t = (t || '').trim();
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return t;
  if (t.startsWith('@')) return `https://instagram.com/${t.slice(1)}`;
  if (t.includes('.')) return `https://${t}`;
  return `https://${t}.com`;
}

/* ------------------------------- status ------------------------------- */
async function fetchStatus() {
  try {
    const d = await api('/api/status');
    state.desktopUrl = d.desktopUrl;
    $('desktopLink').href = d.desktopUrl || '#';
    const dot = $('vmDot');
    const txt = $('vmStatusText');
    const running = (d.vmStatus || '').toLowerCase() === 'running';
    dot.className = 'dot ' + (running ? 'is-ok' : 'is-warn');
    txt.textContent = running ? 'cloud machine online' : (d.vmStatus || 'starting');
  } catch (_) {
    $('vmDot').className = 'dot is-err';
    $('vmStatusText').textContent = 'offline';
  }
}

/* --------------------------- websocket live --------------------------- */
function initWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  try { state.ws = new WebSocket(`${proto}//${location.host}`); } catch (_) { return; }
  state.ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.event === 'connection_updated' && state.conn && m.payload && m.payload.id === state.conn.id) {
      loadActiveConnection();
    }
  };
  state.ws.onclose = () => setTimeout(initWebSocket, 3000);
}

/* ------------------------------- hero -------------------------------- */
function bindHero() {
  $('askForm').addEventListener('submit', (e) => { e.preventDefault(); startConnection($('askInput').value); });
  document.querySelectorAll('#exampleChips .chip').forEach((c) => {
    c.addEventListener('click', () => { $('askInput').value = c.dataset.url; startConnection(c.dataset.url); });
  });
  $('switchSiteBtn') && $('switchSiteBtn').addEventListener('click', showHero);
}

function showHero() {
  $('workspaceView').classList.add('hidden');
  $('heroView').classList.remove('hidden');
  if (state.screenTimer) clearInterval(state.screenTimer);
  $('askInput').focus();
}
function showWorkspace() {
  $('heroView').classList.add('hidden');
  $('workspaceView').classList.remove('hidden');
  if (state.screenTimer) clearInterval(state.screenTimer);
  state.screenTimer = setInterval(refreshScreenshot, 15000);
}

async function startConnection(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) { toast('Type a website address first.'); return; }
  const btn = $('askForm').querySelector('button');
  btn.disabled = true; btn.textContent = 'Starting…';
  try {
    const d = await api('/api/connections', { method: 'POST', body: JSON.stringify({ url }) });
    state.conn = d.connection;
    state.integration = d.integration;
    renderConnection();
    showWorkspace();
    setScreenOverlay(true, 'Opening your private browser…');
    await refreshScreenshot();
    // auto verify session; if not signed in, offer sign-in
    verifySession(true);
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Build my MCP';
  }
}

async function loadActiveConnection() {
  try {
    const d = await api('/api/connections');
    if (d.active) {
      state.conn = d.active;
      state.integration = d.integration;
      renderConnection();
      showWorkspace();
      await refreshScreenshot();
    } else {
      showHero();
    }
  } catch (_) { showHero(); }
}

/* --------------------------- connection UI --------------------------- */
function renderConnection() {
  const c = state.conn;
  if (!c) return;
  $('connName').textContent = c.label || c.domain;
  $('screenDomain').textContent = c.domain;
  const fav = $('connFav');
  fav.innerHTML = `<img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(c.domain)}&sz=64" alt="" onerror="this.parentNode.textContent='🌐'">`;
  renderStatus(c.status);
  renderIntegration();
  renderTools();
  renderActivity();
}

function renderStatus(status) {
  const map = {
    new: ['is-warn', 'Not signed in'],
    authenticating: ['is-warn', 'Waiting for sign-in'],
    needs_auth: ['is-warn', 'Needs sign-in'],
    connected: ['is-ok', 'Connected — session active'],
    error: ['is-err', 'Error']
  };
  const [cls, label] = map[status] || ['is-warn', status || '—'];
  $('connDot').className = 'dot ' + cls;
  $('connStatusText').textContent = label;
  const signedIn = status === 'connected';
  $('signInBtn').textContent = signedIn ? 'Re-sign in' : 'Sign in';
}

function renderIntegration() {
  const i = state.integration;
  if (!i) return;
  $('mcpUrl').textContent = i.mcpUrl;
  $('restUrl').textContent = i.restUrl;
  $('apiKey').dataset.full = i.apiKey || '';
  $('apiKey').textContent = maskKey(i.apiKey);
  $('curlSnippet').textContent = i.curl || '';
}
function maskKey(k) { if (!k) return '—'; return k.slice(0, 11) + '•'.repeat(10) + k.slice(-4); }

function renderTools() {
  const list = $('toolList');
  const tools = (state.conn && state.conn.tools) || [];
  $('toolCount').textContent = tools.length;
  if (!tools.length) { list.innerHTML = '<p class="muted">Run an instruction and save it as a tool to grow this list.</p>'; return; }
  list.innerHTML = tools.map((t) => `
    <div class="tool">
      <div>
        <div class="tool__name">${esc(t.name)}</div>
        <div class="tool__desc">${esc(t.description || t.title || '')}</div>
      </div>
      <span class="tag tag--${t.risk === 'write' ? 'write' : 'read'}">${t.risk === 'write' ? 'write' : 'read'}</span>
    </div>`).join('');
}

function renderActivity() {
  const list = $('activityList');
  const runs = (state.conn && state.conn.runs) || [];
  if (!runs.length) { list.innerHTML = '<p class="muted">No runs yet.</p>'; return; }
  list.innerHTML = runs.slice(0, 20).map((r) => `
    <div class="activity__item">
      <time>${new Date(r.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
      <span>${esc(r.instruction || r.action || 'run')} ${r.risk === 'write' ? '· <span style="color:var(--warn)">write</span>' : ''}</span>
    </div>`).join('');
}

/* --------------------------- conn actions --------------------------- */
function bindConnActions() {
  $('signInBtn').addEventListener('click', openLoginModal);
  $('verifyBtn').addEventListener('click', () => verifySession(false));
}

async function verifySession(silent) {
  if (!state.conn) return;
  if (!silent) toast('Checking your session…');
  try {
    const d = await api(`/api/connections/${state.conn.id}/verify`, { method: 'POST', body: '{}' });
    state.conn.status = d.authenticated ? 'connected' : 'needs_auth';
    renderStatus(state.conn.status);
    await refreshScreenshot();
    if (!silent) toast(d.authenticated ? 'Signed in and ready.' : 'Not signed in yet.');
    if (!d.authenticated && !silent) openLoginModal();
  } catch (e) { if (!silent) toast(e.message); }
}

/* ------------------------------ screen ------------------------------ */
function bindScreen() {
  const img = $('screenImg');
  const frame = $('screenFrame');
  img.addEventListener('click', onScreenClick);
  frame.addEventListener('wheel', (e) => {
    e.preventDefault();
    state.scrollAccum += e.deltaY > 0 ? 300 : -300;
    clearTimeout(state.scrollTimer);
    state.scrollTimer = setTimeout(() => { const dy = state.scrollAccum; state.scrollAccum = 0; sendInput({ action: 'scroll', dy }); }, 110);
  }, { passive: false });
  $('refreshBtn').addEventListener('click', refreshScreenshot);
  $('gotoUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') goTo(); });
  $('typeBtn').addEventListener('click', sendTyped);
  $('enterBtn').addEventListener('click', () => sendInput({ action: 'key', key: 'Return' }));
  $('typeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendTyped(); } });
}

function setScreenOverlay(show, text) {
  const o = $('screenOverlay');
  if (text) $('screenOverlayText').textContent = text;
  o.style.display = show ? 'flex' : 'none';
}

async function goTo() {
  const url = normalizeUrl($('gotoUrl').value);
  if (!url) return refreshScreenshot();
  setScreenOverlay(true, 'Loading…');
  try {
    const d = await api('/api/browser/screenshot', { method: 'POST', body: JSON.stringify({ url }) });
    applyScreenshot(d);
  } catch (_) {} finally { setScreenOverlay(false); }
}

async function refreshScreenshot() {
  try {
    const d = await api('/api/browser/screenshot', { method: 'POST', body: '{}' });
    applyScreenshot(d);
  } catch (_) {} finally { setScreenOverlay(false); }
}

function applyScreenshot(d) {
  if (d && d.screenshot) { $('screenImg').src = `data:image/png;base64,${d.screenshot}`; setScreenOverlay(false); }
  if (d && (d.url || d.title)) $('gotoUrl').placeholder = d.url || d.title;
}

async function onScreenClick(e) {
  const img = e.currentTarget;
  const rect = img.getBoundingClientRect();
  // account for object-fit: contain letterboxing
  const natRatio = img.naturalWidth / img.naturalHeight;
  const boxRatio = rect.width / rect.height;
  let dispW = rect.width, dispH = rect.height, offX = 0, offY = 0;
  if (natRatio > boxRatio) { dispH = rect.width / natRatio; offY = (rect.height - dispH) / 2; }
  else { dispW = rect.height * natRatio; offX = (rect.width - dispW) / 2; }
  const x = (e.clientX - rect.left - offX) / dispW * img.naturalWidth;
  const y = (e.clientY - rect.top - offY) / dispH * img.naturalHeight;
  if (x < 0 || y < 0 || !isFinite(x)) return;
  await sendInput({ action: 'click', x: Math.round(x), y: Math.round(y) });
}

async function sendTyped() {
  const el = $('typeInput');
  if (!el.value) return;
  await sendInput({ action: 'type', text: el.value });
  el.value = '';
}

async function sendInput(body) {
  if (state.inputInFlight) return;
  state.inputInFlight = true;
  try {
    const d = await api('/api/browser/input', { method: 'POST', body: JSON.stringify(body) });
    applyScreenshot(d);
  } catch (_) {} finally { state.inputInFlight = false; }
}

/* ------------------------------- tabs ------------------------------- */
function bindTabs() {
  document.querySelectorAll('#panelTabs .tab').forEach((t) => {
    t.addEventListener('click', () => {
      document.querySelectorAll('#panelTabs .tab').forEach((x) => x.classList.toggle('is-active', x === t));
      document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('is-active', p.dataset.pane === t.dataset.tab));
    });
  });
}

/* --------------------------- login modal ---------------------------- */
function bindLoginModal() {
  $('loginClose').addEventListener('click', closeLoginModal);
  $('loginModal').addEventListener('click', (e) => { if (e.target === $('loginModal')) closeLoginModal(); });
  $('loginManual').addEventListener('click', () => {
    closeLoginModal();
    toast('Sign in directly on the live screen, then tap “Verify session”.');
  });
  $('loginForm').addEventListener('submit', submitLogin);
}

async function openLoginModal() {
  if (!state.conn) return;
  $('loginModal').classList.remove('hidden');
  $('loginSite').textContent = state.conn.domain;
  $('loginTitle').textContent = 'Sign in to ' + state.conn.domain;
  $('loginFields').innerHTML = '<div style="display:grid;place-items:center;padding:1.4rem"><div class="spinner"></div></div>';
  $('ssoRow').innerHTML = '';
  setLoginBusy(false);
  try {
    const form = await api(`/api/connections/${state.conn.id}/open-login`, { method: 'POST', body: '{}' });
    if (form.screenshot) applyScreenshot({ screenshot: form.screenshot });
    if (!form.ok) {
      $('loginFields').innerHTML = `<p class="muted">${esc(form.message || 'Could not read the login page. Sign in on the live screen, then tap “Verify session”.')}</p>`;
      return;
    }
    state.loginForm = form;
    renderLoginFields(form);
  } catch (e) {
    $('loginFields').innerHTML = `<p class="muted">${esc(e.message)}</p>`;
  }
}

function renderLoginFields(form) {
  const fields = form.fields || [];
  if (!fields.length) {
    $('loginFields').innerHTML = '<p class="muted">This site uses a sign-in flow we can’t pre-fill. Use the live screen, then tap “Verify session”.</p>';
  } else {
    $('loginFields').innerHTML = fields.map((f) => {
      const t = f.type === 'password' ? 'password' : f.type === 'otp' ? 'text' : f.type === 'email' ? 'email' : 'text';
      const cls = f.type === 'otp' ? 'field field--otp' : 'field';
      const extra = f.type === 'otp' ? 'inputmode="numeric" maxlength="8"' : '';
      return `<div class="${cls}"><label>${esc(f.label)}</label><input data-fid="${esc(f.id)}" type="${t}" ${extra} autocomplete="off"></div>`;
    }).join('');
  }
  const sso = form.ssoButtons || [];
  $('ssoRow').innerHTML = sso.length
    ? sso.map((s) => `<button type="button" class="ghost-btn sso__btn" data-ref="${esc(s.ref)}">${esc(s.label)}</button>`).join('')
    : '';
  $('ssoRow').querySelectorAll('.sso__btn').forEach((b) => b.addEventListener('click', () => ssoClick(b.dataset.ref)));
  const first = $('loginFields').querySelector('input');
  if (first) first.focus();
}

async function ssoClick(ref) {
  setLoginBusy(true, 'Opening provider…');
  try {
    await api('/api/browser/input', { method: 'POST', body: JSON.stringify({ action: 'click', ref }) }).catch(() => {});
    toast('Continue the provider sign-in on the live screen, then tap “Verify session”.');
    closeLoginModal();
  } finally { setLoginBusy(false); }
}

async function submitLogin(e) {
  e.preventDefault();
  if (!state.conn) return;
  const values = {};
  $('loginFields').querySelectorAll('input[data-fid]').forEach((i) => { if (i.value) values[i.dataset.fid] = i.value; });
  setLoginBusy(true, 'Signing you in…');
  try {
    const d = await api(`/api/connections/${state.conn.id}/login`, { method: 'POST', body: JSON.stringify({ values, submit: true }) });
    if (d.screenshot) applyScreenshot({ screenshot: d.screenshot });
    if (d.needsOtp) {
      toast('Enter the verification code the site sent.');
      // refresh form to show OTP field
      const form = await api(`/api/connections/${state.conn.id}/open-login`, { method: 'POST', body: '{}' });
      if (form.ok) { state.loginForm = form; renderLoginFields(form); }
      setLoginBusy(false);
      return;
    }
    if (d.authenticated) {
      state.conn.status = 'connected';
      renderStatus('connected');
      closeLoginModal();
      toast('Signed in. Your MCP is ready.');
      loadActiveConnection();
    } else {
      setLoginBusy(false);
      toast('Not signed in yet — check the details or use the live screen.');
    }
  } catch (err) {
    setLoginBusy(false);
    toast(err.message);
  }
}

function setLoginBusy(on, text) {
  $('loginBusy').classList.toggle('hidden', !on);
  $('loginForm').style.display = on ? 'none' : 'block';
  if (text) $('loginBusyText').textContent = text;
}
function closeLoginModal() { $('loginModal').classList.add('hidden'); setLoginBusy(false); }

/* ------------------------------ run / chat ------------------------------ */
function bindRunForm() {
  $('runForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const instruction = $('runInput').value.trim();
    if (!instruction || !state.conn) return;
    const saveAs = $('saveAs').value.trim().replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    $('runInput').value = '';
    pushBubble('user', instruction);
    const btn = $('runForm').querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Running…';
    pushBubble('ai', 'Working on it in your cloud browser…', 'thinking');
    try {
      const d = await api(`/api/connections/${state.conn.id}/run`, { method: 'POST', body: JSON.stringify({ instruction, saveAs: saveAs || undefined }) });
      removeThinking();
      if (d.ok) {
        const text = typeof d.result === 'string' ? d.result : 'Done.';
        pushBubble('ai', text);
        renderResult(d.result);
        if (saveAs) { toast(`Saved tool “${saveAs}”.`); loadActiveConnection(); }
      } else {
        pushBubble('ai', d.error || 'Could not complete that.');
      }
    } catch (err) {
      removeThinking();
      pushBubble('ai', err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Run';
      $('saveAs').value = '';
    }
  });
}

function pushBubble(role, text, cls) {
  const log = $('chatLog');
  const d = document.createElement('div');
  d.className = 'bubble bubble--' + role + (cls ? ' ' + cls : '');
  d.textContent = text;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
}
function removeThinking() { const t = document.querySelector('.bubble.thinking'); if (t) t.remove(); }

function renderResult(result) {
  const box = $('runResult');
  if (result == null) { box.innerHTML = ''; return; }
  if (typeof result === 'string') { box.innerHTML = ''; return; }
  box.innerHTML = `<pre>${esc(JSON.stringify(result, null, 2))}</pre>`;
}

/* ------------------------------- copy ------------------------------- */
function bindCopy() {
  document.querySelectorAll('.copy[data-copy]').forEach((b) => {
    b.addEventListener('click', () => {
      const el = $(b.dataset.copy);
      const text = b.dataset.copy === 'apiKey' ? (el.dataset.full || el.textContent) : el.textContent;
      navigator.clipboard.writeText(text).then(() => toast('Copied.')).catch(() => toast('Copy failed.'));
    });
  });
  $('revealKey').addEventListener('click', () => {
    const el = $('apiKey');
    const full = el.dataset.full || '';
    if (el.classList.contains('secret')) { el.textContent = full; el.classList.remove('secret'); $('revealKey').textContent = 'Hide'; }
    else { el.textContent = maskKey(full); el.classList.add('secret'); $('revealKey').textContent = 'Reveal'; }
  });
}
