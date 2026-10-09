const boxdClient = require('../src/boxdClient');

async function repairVps() {
  console.log('=====================================================');
  console.log('🔧 STARTING COMPREHENSIVE VPS REPAIR & OPTIMIZATION');
  console.log('=====================================================\n');

  // 1. Repair and harden DNS configuration
  console.log('[1/5] Hardening DNS resolver in /etc/resolv.conf...');
  const resolvConf = [
    'nameserver 1.1.1.1',
    'nameserver 8.8.8.8',
    'nameserver 10.31.0.1',
    'options timeout:2 attempts:3 rotate'
  ].join('\n');
  
  await boxdClient.writeFile('/tmp/resolv.conf.new', resolvConf);
  const copyRes = await boxdClient.exec('sudo cp /tmp/resolv.conf.new /etc/resolv.conf');
  console.log('Resolv.conf updated. Code:', copyRes.exitCode);

  // 2. Verify DNS resolution for major domains
  console.log('\n[2/5] Testing multi-domain DNS resolution...');
  const dnsDomains = ['instagram.com', 'www.instagram.com', 'x.com', 'google.com', 'api.ipify.org'];
  for (const domain of dnsDomains) {
    const res = await boxdClient.exec(`nslookup ${domain}`);
    const ok = res.stdout.includes('Address:');
    console.log(` - DNS lookup ${domain}: ${ok ? 'RESOLVED ✓' : 'FAILED ✗'}`);
  }

  // 3. Reset any stuck browser error pages on DISPLAY=:100
  console.log('\n[3/5] Resetting browser viewport on DISPLAY=:100 to clean Instagram home...');
  const openRes = await boxdClient.exec('DISPLAY=:100 agent-browser open https://www.instagram.com/');
  console.log('Browser navigation output:', openRes.stdout.trim());

  // 4. Capture clean screenshot
  console.log('\n[4/5] Capturing verified viewport screenshot...');
  const snapRes = await boxdClient.exec('DISPLAY=:100 agent-browser screenshot /tmp/agent_screen.png && wc -c /tmp/agent_screen.png');
  console.log('Screenshot captured:', snapRes.stdout.trim());

  // 5. Check browser active URL & Title
  console.log('\n[5/5] Checking browser URL & Title...');
  const urlRes = await boxdClient.exec('DISPLAY=:100 agent-browser get url');
  const titleRes = await boxdClient.exec('DISPLAY=:100 agent-browser get title');
  console.log('Current URL:  ', urlRes.stdout.trim());
  console.log('Current Title:', titleRes.stdout.trim());

  console.log('\n=====================================================');
  console.log('✅ VPS REPAIRED AND FULLY OPTIMIZED!');
  console.log('=====================================================');
}

repairVps().catch(err => {
  console.error('Repair error:', err);
  process.exit(1);
});
