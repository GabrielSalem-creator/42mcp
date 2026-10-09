const vm = require('../src/vmShell');
const sa = require('../src/siteAgent');
(async () => {
  await vm.open('https://github.com/login'); await vm.sleep(2500);
  const snap = await vm.snapshot({ interactive: true });
  const els = sa.parseSnapshot(snap);
  const tb = els.filter(e => /textbox/.test(e.role));
  console.log('textboxes:', tb.map(e => e.ref + '=' + e.name));
  // fill distinct values
  const u = tb.find(e=>/user|email/i.test(e.name)), p = tb.find(e=>/password/i.test(e.name));
  if (u) await vm.agentBrowser(['fill','@'+u.ref,'TESTUSER123']);
  if (p) await vm.agentBrowser(['fill','@'+p.ref,'TESTPASS456']);
  await vm.sleep(500);
  // read back
  for (const e of tb) {
    const r = await vm.agentBrowser(['get','value','@'+e.ref]);
    console.log(e.ref, e.name, '=>', (r.stdout||'').trim().split('\n').pop());
  }
})().catch(e=>console.log('ERR',e.message));
