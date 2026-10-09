const fs = require('fs');
const path = require('path');
const boxdClient = require('../src/boxdClient');

const DEPLOYMENTS = [
  { local: 'scripts/vm_agent_controller.py', remote: '/home/boxd/vm_agent_controller.py' },
  { local: 'scripts/vm_browser_runner.py', remote: '/home/boxd/vm_browser_runner.py' }
];

async function syncVmScripts() {
  console.log('Syncing VM automation scripts to Boxd VPS...\n');
  const root = path.resolve(__dirname, '..');

  for (const { local, remote } of DEPLOYMENTS) {
    const localPath = path.join(root, local);
    const content = fs.readFileSync(localPath, 'utf8');
    process.stdout.write(`  ${local} -> ${remote} ... `);
    const res = await boxdClient.writeFile(remote, content);
    if (res.exitCode !== 0) {
      console.log('FAILED');
      throw new Error(res.stderr || `upload failed (exit ${res.exitCode})`);
    }
    console.log('OK');
  }

  await boxdClient.exec('chmod +x /home/boxd/vm_agent_controller.py /home/boxd/vm_browser_runner.py');
  console.log('\nVM scripts are up to date.');
}

syncVmScripts().catch((err) => {
  console.error('\nSync failed:', err.message);
  process.exit(1);
});
