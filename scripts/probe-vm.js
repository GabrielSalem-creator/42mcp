#!/usr/bin/env node
/**
 * Ensures the Boxd VM exists + is running, then reports what tooling is
 * installed on it (display, browser, agent-browser, python, node, cursor).
 * Usage: node scripts/probe-vm.js
 */
const boxdClient = require('../src/boxdClient');
const config = require('../src/config');

const PROBE = [
  'echo "DISPLAY=$DISPLAY"',
  'echo "user=$(whoami) home=$HOME"',
  'head -2 /etc/os-release',
  'for c in agent-browser chromium chromium-browser google-chrome google-chrome-stable xpra Xvfb python3 pip3 node npm npx curl git agent cursor-agent; do printf "%s: " "$c"; command -v "$c" || echo MISSING; done',
  'python3 -c "import playwright; print(\'playwright-python: ok\')" 2>&1 | tail -1',
  'ls /home',
  'ps aux | grep -i -E "xpra|Xvfb|chrome|agent-browser" | grep -v grep | awk \'{print $11, $12, $13}\' | head -6',
  'echo "cpus=$(nproc)"; free -m | sed -n 2p; df -h / | tail -1',
  'ls /usr/local/bin 2>/dev/null | head -40'
].join('; ');

async function main() {
  if (!config.apiKey) {
    console.error('Missing BOXD_API_KEY in .env');
    process.exit(1);
  }
  const name = config.defaultVmName;
  let machine = await boxdClient.getMachine(name);
  if (!machine) {
    console.log(`VM "${name}" not found on this account — creating...`);
    machine = await boxdClient.ensureMachine(name);
  }
  if (machine.status !== 'running') {
    console.log(`VM status is "${machine.status}" — starting...`);
    try { await boxdClient.startMachine(name); } catch (e) { console.warn('start:', e.message); }
    try { await boxdClient.boxd.machines.waitUntilReady(name, { timeout: 180000 }); } catch (e) { console.warn('wait:', e.message); }
    machine = await boxdClient.getMachine(name);
  }
  console.log(`VM: ${machine.name} [${machine.status}] id=${machine.id}`);
  console.log(`Image: ${machine.imageRef}`);
  console.log(`Resources: ${machine.resources?.vcpu} vCPU, ${Math.round((machine.resources?.memoryBytes || 0) / 1073741824)} GB RAM`);
  console.log(`Desktop: ${machine.access?.desktopUrl}`);
  console.log(`URL: ${machine.access?.url || '-'}  SSH port: ${machine.access?.sshPort || '-'}`);
  console.log('\n--- probe ---');
  const r = await boxdClient.exec(`bash -lc '${PROBE.replace(/'/g, `'\\''`)}'`, name, 90000);
  console.log(r.stdout);
  if (r.stderr) console.log('[stderr]', r.stderr.slice(0, 800));
  console.log('exit', r.exitCode);
}

main().catch((e) => {
  console.error('probe failed:', e.message);
  process.exit(1);
});
