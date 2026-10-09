#!/usr/bin/env node
/** Rewrite the VM .env cleanly (fixes any concatenated lines). */
const boxdClient = require('../src/boxdClient');
const config = require('../src/config');

const env = [
  `BOXD_API_KEY=${config.apiKey}`,
  `BOXD_DEFAULT_VM=${config.defaultVmName}`,
  'PORT=3000',
  'HOST=0.0.0.0',
  'VM_LOCAL=1',
  'PUBLIC_BASE_URL=https://www.42mcp.tech',
  'AGENT_BRAINS=artbloom,local',
  `ARTBLOOM_API_BASE=${config.artbloomBaseUrl}`,
  `ARTBLOOM_API_KEY=${config.artbloomApiKey}`,
  'ARTBLOOM_MODEL=glm-5.3',
  'ARTBLOOM_TIMEOUT_MS=45000',
  'DATA_DIR=/home/boxd/sitemcp/data',
  ''
].join('\n');

(async () => {
  const r = await boxdClient.writeFile('/home/boxd/sitemcp/.env', env);
  console.log('write .env:', r.exitCode === 0 ? 'ok' : 'FAIL ' + r.stderr);
  const check = await boxdClient.exec('grep -c "=" /home/boxd/sitemcp/.env', undefined, 15000);
  console.log('lines with =:', check.stdout.trim());
})().catch((e) => { console.error(e.message); process.exit(1); });
