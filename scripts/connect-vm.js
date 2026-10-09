#!/usr/bin/env node
/**
 * Ensures Boxd VM is reachable and automation scripts are on the machine.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const boxdClient = require('../src/boxdClient');
const config = require('../src/config');
const fs = require('fs');
const { execSync } = require('child_process');

async function main() {
  console.log('Connecting to Boxd VM...\n');

  if (!config.apiKey) {
    console.error('Missing BOXD_API_KEY in .env');
    process.exit(1);
  }

  const machine = await boxdClient.ensureMachine(config.defaultVmName);
  console.log(`VM: ${machine.name} — ${machine.status || 'unknown'}`);

  if (machine.status !== 'running') {
    console.log('Starting VM...');
    await boxdClient.startMachine(config.defaultVmName);
    const ready = await boxdClient.getMachine(config.defaultVmName);
    console.log(`VM now: ${ready?.status}`);
  }

  const desktop = await boxdClient.getDesktopUrl();
  console.log(`Desktop: ${desktop}`);

  console.log('\nSyncing browser scripts to VM...');
  execSync('node scripts/sync_vm_scripts.js', {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit'
  });

  const probe = await boxdClient.exec('python3 /home/boxd/vm_agent_controller.py check-login instagram', undefined, 45000);
  const ok = probe.stdout.includes('"connected"');
  console.log(`\nInstagram session on VM: ${ok ? 'detected' : 'not detected (log in via web UI or VM desktop)'}`);
  console.log('\nVM is ready for MCP (vm_do) and web chat.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
