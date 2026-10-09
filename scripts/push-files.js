#!/usr/bin/env node
/**
 * Upload changed source files to the VM app dir (/home/boxd/sitemcp).
 * Usage: node scripts/push-files.js src/vmShell.js client/app.js ...
 * With no args, pushes the standard app file set.
 */
const fs = require('fs');
const path = require('path');
const boxdClient = require('../src/boxdClient');

const DEFAULT = [
  'src/vmShell.js', 'src/server.js', 'src/siteAgent.js', 'src/connectionStore.js',
  'src/mcpHttp.js', 'src/config.js', 'src/boxdClient.js',
  'client/index.html', 'client/style.css', 'client/app.js'
];
const REMOTE = '/home/boxd/sitemcp';

async function main() {
  const files = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT;
  for (const f of files) {
    const local = path.resolve(__dirname, '..', f);
    if (!fs.existsSync(local)) { console.log(f, 'MISSING'); continue; }
    const r = await boxdClient.writeFile(`${REMOTE}/${f}`, fs.readFileSync(local, 'utf8'));
    console.log(f, r.exitCode === 0 ? 'ok' : 'FAIL ' + r.stderr);
  }
  console.log('done');
}
main().catch((e) => { console.error('push failed:', e.message); process.exit(1); });
