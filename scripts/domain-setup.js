#!/usr/bin/env node
/**
 * Prints the DNS records needed to point a custom domain at the Boxd VM,
 * and (with --create) binds the domain once records are live.
 * Usage: node scripts/domain-setup.js 42mcp.tech [--create]
 */
const boxdClient = require('../src/boxdClient');
const config = require('../src/config');

async function publicIp(name) {
  const r = await boxdClient.exec('curl -fsS --max-time 10 https://api.ipify.org || curl -fsS --max-time 10 ifconfig.me', name, 20000);
  return (r.stdout || '').trim();
}

async function main() {
  const domain = process.argv[2] || '42mcp.tech';
  const doCreate = process.argv.includes('--create');
  const b = boxdClient.boxd;
  if (!b) throw new Error('Boxd SDK unavailable');

  const name = config.defaultVmName;
  const machine = await boxdClient.getMachine(name);
  const cfg = await b.account.config();
  const zone = cfg.zone;
  const ip = await publicIp(name);

  console.log(`Machine: ${name}  (${machine.access?.url})`);
  console.log(`Zone: ${zone}`);
  console.log(`Public IP: ${ip || '(could not detect — check VM egress)'}`);
  console.log('\nDNS records to create at your registrar (manage.get.tech):');
  console.log(`  A      @ (or ${domain})         -> ${ip}`);
  console.log(`  CNAME  *.${domain}               -> ${name}.${zone}`);
  console.log('\nSDK dnsInstructions:');
  try {
    console.log(b.domains.dnsInstructions(domain, { machineName: name, machineIp: ip, zone }));
  } catch (e) { console.log('(dnsInstructions error:', e.message, ')'); }

  if (doCreate) {
    console.log('\nBinding domain (DNS must already be live)...');
    const d = await b.domains.create({ domain, machine: name });
    console.log('status:', d.status, 'lastError:', d.lastError || '(none)');
  } else {
    console.log('\nRun again with --create AFTER the DNS records are live to bind + issue certs.');
  }
  try { console.log('\nExisting bound domains:', JSON.stringify(await b.domains.list())); } catch (_) {}
}

main().catch((e) => { console.error('domain-setup failed:', e.message); process.exit(1); });
