#!/usr/bin/env node
/**
 * Deploy the app onto the Boxd VM so it serves at https://42mcp.tech.
 *  - uploads source files (no node_modules)
 *  - writes a VM-side .env with VM_LOCAL=1 (shell commands run locally on the VM)
 *  - npm install, then runs it under a systemd service on port 3000
 *    (Boxd's default route auto-detects port 3000)
 * Usage: node scripts/deploy-vm.js
 */
const fs = require('fs');
const path = require('path');
const boxdClient = require('../src/boxdClient');
const config = require('../src/config');

const ROOT = path.resolve(__dirname, '..');
const REMOTE = '/home/boxd/sitemcp';
const NAME = config.defaultVmName;

function walk(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(rel, base));
    else out.push(rel.replace(/\\/g, '/'));
  }
  return out;
}

async function uploadFile(localRel) {
  const localPath = path.join(ROOT, localRel);
  const remotePath = `${REMOTE}/${localRel}`;
  const buf = fs.readFileSync(localPath);
  await boxdClient.boxd.machines.files.mkdir(NAME, path.posix.dirname(remotePath)).catch(() => {});
  await boxdClient.boxd.machines.files.upload(NAME, remotePath, buf);
}

async function main() {
  if (!boxdClient.boxd) throw new Error('Boxd SDK unavailable');
  const serviceOnly = process.argv.includes('--service-only');
  if (serviceOnly) { console.log('Starting service only (skipping upload/install)...'); await startService(); return; }
  console.log(`Deploying to ${NAME}:${REMOTE} ...`);

  const files = [
    'package.json',
    'package-lock.json',
    ...walk('src'),
    ...walk('client'),
    'scripts/vm_agent_controller.py',
    'scripts/vm_browser_runner.py'
  ];

  // Clean remote app dir (keep node_modules for faster re-deploys)
  await boxdClient.exec(`mkdir -p ${REMOTE} && find ${REMOTE} -maxdepth 2 -type f \\( -name '*.js' -o -name '*.py' -o -name '*.css' -o -name '*.html' -o -name '*.json' \\) -not -path '*/node_modules/*' -delete 2>/dev/null; true`, NAME, 30000);

  for (const f of files) {
    process.stdout.write(`  ↑ ${f} ... `);
    await uploadFile(f);
    console.log('ok');
  }

  // VM-side .env (local exec mode)
  const envLines = [
    `BOXD_API_KEY=${config.apiKey}`,
    `BOXD_DEFAULT_VM=${NAME}`,
    'PORT=3000',
    'HOST=0.0.0.0',
    'VM_LOCAL=1',
    'PUBLIC_BASE_URL=https://42mcp.tech',
    'AGENT_BRAINS=artbloom,local',
    `ARTBLOOM_API_BASE=${config.artbloomBaseUrl}`,
    `ARTBLOOM_API_KEY=${config.artbloomApiKey}`,
    `ARTBLOOM_MODEL=${config.artbloomModel}`,
    'DATA_DIR=/home/boxd/sitemcp/data'
  ].join('\n');
  await boxdClient.writeFile(`${REMOTE}/.env`, envLines, NAME);
  console.log('  ↑ .env (VM_LOCAL=1) ok');

  console.log('\nInstalling dependencies on VM (npm install --omit=dev)...');
  const install = await boxdClient.exec(`cd ${REMOTE} && npm install --omit=dev --no-audit --no-fund 2>&1 | tail -4`, NAME, 240000);
  console.log(install.stdout || install.stderr);

  if (process.argv.includes('--prep-only')) {
    console.log('\nPrep complete (files + deps on VM). Service not started (--prep-only).');
    console.log('Go live with: npm run go-live');
    return;
  }

  await startService();
}

async function startService() {
  // systemd service
  const unit = [
    '[Unit]',
    'Description=42MCP web + MCP server',
    'After=network-online.target boxd-desktop.service',
    '',
    '[Service]',
    'Type=simple',
    'User=boxd',
    `WorkingDirectory=${REMOTE}`,
    'Environment=DISPLAY=:100',
    `ExecStartPre=/bin/bash -lc 'systemctl is-active --quiet boxd-desktop.service || sudo systemctl start boxd-desktop.service || true'`,
    `ExecStart=/usr/local/bin/node ${REMOTE}/src/server.js`,
    'Restart=always',
    'RestartSec=3',
    '',
    '[Install]',
    'WantedBy=multi-user.target'
  ].join('\n');
  await boxdClient.writeFile('/tmp/42mcp.service', unit, NAME);
  const svc = await boxdClient.exec(
    'sudo cp /tmp/42mcp.service /etc/systemd/system/42mcp.service && sudo systemctl daemon-reload && sudo systemctl enable 42mcp.service && sudo systemctl restart 42mcp.service && sleep 3 && systemctl is-active 42mcp.service',
    NAME, 60000
  );
  console.log('service:', (svc.stdout || svc.stderr).trim());

  // ensure Boxd default route points at port 3000
  try {
    await boxdClient.boxd.machines.proxies.setPort(NAME, 3000);
    console.log('route: default → port 3000');
  } catch (e) { console.log('route setPort:', e.message); }

  const health = await boxdClient.exec('curl -fsS --max-time 8 http://localhost:3000/api/status | head -c 200 || echo FAILED', NAME, 20000);
  console.log('\nlocal health:', health.stdout.trim());
  console.log('\nDone. Public: https://sitemcp-core.boxd.sh  and  https://42mcp.tech (once DNS/cert active).');
}

main().catch((e) => { console.error('deploy failed:', e.message); process.exit(1); });
