const vm = require('../src/vmShell');
const sa = require('../src/siteAgent');
(async () => {
  for (const g of ['https://github.com/login','https://github.com']) {
    await vm.open(g); await vm.sleep(2500);
    const url = await vm.getUrl();
    const snap = await vm.snapshot();
    const els = sa.parseSnapshot(snap);
    console.log('GUESS', g, '=> url', url, 'els', els.length,
      'textboxes', JSON.stringify(els.filter(e=>/textbox|combobox/.test(e.role)).map(e=>e.name)));
    console.log('  first 8 lines:\n' + snap.split('\n').slice(0,8).join('\n'));
  }
})().catch(e=>console.log('ERR',e.message));
