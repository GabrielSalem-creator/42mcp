const vm = require('../src/vmShell');
const sa = require('../src/siteAgent');
(async () => {
  await vm.open('https://github.com/login'); await vm.sleep(2500);
  const snap = await vm.snapshot({ interactive: true });
  const url = await vm.getUrl(); const title = await vm.getTitle();
  console.log('snapshot len:', snap.length);
  const c = require('../src/config');
  // direct LLM call to see raw output
  const out = await (async () => {
    const r = await fetch(c.artbloomBaseUrl.replace(/\/$/,'')+'/chat/completions', {
      method:'POST', headers:{'Content-Type':'application/json',Authorization:'Bearer '+c.artbloomApiKey},
      body: JSON.stringify({model:c.artbloomModel, temperature:0, max_tokens:400, messages:[
        {role:'system',content:'Read the accessibility tree and return STRICT JSON only: {"step":"credentials","fields":[{"ref":"e#","label":"..","type":"username|password|email|otp"}],"authenticated":false}'},
        {role:'user',content:'URL:'+url+'\n'+snap.slice(0,5000)}
      ]})
    });
    return r.status + ' :: ' + (await r.text()).slice(0, 400);
  })();
  console.log('RAW:', out);
})().catch(e => console.log('ERR', e.message));
