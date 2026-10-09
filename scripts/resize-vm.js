#!/usr/bin/env node
/**
 * Resize the Boxd VM. Default: 4 vCPU / 16G.
 * Usage: node scripts/resize-vm.js [vcpu] [memory]
 *        node scripts/resize-vm.js 4 16G
 * A running machine is rebooted to apply the new size (disk survives, RAM does not).
 */
const boxdClient = require('../src/boxdClient');
const config = require('../src/config');

async function main() {
  if (!boxdClient.boxd) throw new Error('Boxd SDK unavailable');
  const vcpu = parseInt(process.argv[2], 10) || 4;
  const memory = process.argv[3] || '16G';
  const name = config.defaultVmName;

  const before = await boxdClient.getMachine(name);
  console.log(`Before: ${before.resources?.vcpu} vCPU, ${Math.round((before.resources?.memoryBytes || 0) / 1073741824)}G [${before.status}]`);
  console.log(`Resizing ${name} -> ${vcpu} vCPU / ${memory} (reboots if running)...`);

  const result = await boxdClient.boxd.machines.resize(name, { vcpu, memory });
  console.log(`Now: ${result.vcpu} vCPU, ${Math.round((result.memoryBytes || 0) / 1073741824)}G  rebooted=${result.rebooted}`);

  // Wait until ready again and restart the desktop so the browser is available
  await boxdClient.boxd.machines.waitUntilReady(name, { timeout: 180000 }).catch(() => {});
  const after = await boxdClient.getMachine(name);
  console.log(`Status: ${after.status}`);
}

main().catch((e) => { console.error('resize failed:', e.message); process.exit(1); });
