const b = require('../src/boxdClient').boxd;
(async () => {
  try { await b.domains.delete('42mcp.tech'); console.log('deleted old binding'); } catch (e) { console.log('delete:', e.message); }
  await new Promise(r => setTimeout(r, 2000));
  try { const d = await b.domains.create({ domain: '42mcp.tech', machine: 'sitemcp-core' }); console.log('rebound:', d.status, d.lastError || ''); } catch (e) { console.log('create:', e.message); }
  try { console.log('now:', JSON.stringify(await b.domains.list())); } catch (_) {}
  await b.close();
})();
