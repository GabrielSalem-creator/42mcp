#!/usr/bin/env node
/**
 * Run a shell command on the Boxd VM from your PC.
 * Usage: node scripts/vm-exec.js "ls -la /home/boxd" [timeoutMs]
 */
const boxdClient = require('../src/boxdClient');

async function main() {
  const command = process.argv[2];
  const timeoutMs = parseInt(process.argv[3], 10) || 120000;
  if (!command) {
    console.error('Usage: node scripts/vm-exec.js "<command>" [timeoutMs]');
    process.exit(1);
  }
  const r = await boxdClient.exec(`bash -lc '${command.replace(/'/g, `'\\''`)}'`, undefined, timeoutMs);
  if (r.stdout) process.stdout.write(r.stdout.endsWith('\n') ? r.stdout : r.stdout + '\n');
  if (r.stderr) process.stderr.write('[stderr] ' + r.stderr.slice(0, 4000) + '\n');
  console.log(`[exit ${r.exitCode}]`);
}

main().catch((e) => {
  console.error('vm-exec failed:', e.message);
  process.exit(1);
});
