const http = require('http');
const { spawn } = require('child_process');

function makeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, (res) => {
      let chunks = '';
      res.on('data', chunk => chunks += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(chunks) });
        } catch (e) {
          resolve({ status: res.statusCode, body: chunks });
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function runMcpTest() {
  return new Promise((resolve, reject) => {
    const mcp = spawn('node', ['src/mcp/server.js']);
    let buffer = '';

    mcp.stdout.on('data', (d) => {
      buffer += d.toString();
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line.trim());
          mcp.kill();
          return resolve(json);
        } catch (e) {}
      }
    });

    mcp.stderr.on('data', () => {});
    mcp.on('error', reject);

    // Send tools/list call
    const listReq = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {}
    }) + '\n';
    mcp.stdin.write(listReq);

    setTimeout(() => {
      mcp.kill();
      resolve({ timeout: true, buffer });
    }, 8000);
  });
}

async function stressTest() {
  console.log('=====================================================');
  console.log('🧪 RUNNING COMPREHENSIVE STRESS TEST SUITE');
  console.log('=====================================================\n');

  let passed = 0;
  let failed = 0;

  // Test 1: System Status
  try {
    process.stdout.write('[TEST 1] GET /api/status ... ');
    const res = await makeRequest('GET', '/api/status');
    if (res.status === 200 && res.body.status === 'ok' && res.body.vmStatus === 'running') {
      console.log('PASSED ✓ (VM: ' + res.body.vmName + ' is RUNNING)');
      passed++;
    } else {
      console.log('FAILED ✗', res);
      failed++;
    }
  } catch (e) {
    console.log('FAILED ✗', e.message);
    failed++;
  }

  // Test 2: Shell execution in VM
  try {
    process.stdout.write('[TEST 2] POST /api/vm/exec (uname -a) ... ');
    const res = await makeRequest('POST', '/api/vm/exec', { command: 'uname -a' });
    if (res.status === 200 && res.body.stdout.includes('Linux')) {
      console.log('PASSED ✓ (' + res.body.stdout.trim() + ')');
      passed++;
    } else {
      console.log('FAILED ✗', res);
      failed++;
    }
  } catch (e) {
    console.log('FAILED ✗', e.message);
    failed++;
  }

  // Test 3: Check Logins
  try {
    process.stdout.write('[TEST 3] POST /api/browser/check-login (Instagram) ... ');
    const res = await makeRequest('POST', '/api/browser/check-login', { platform: 'instagram' });
    if (res.status === 200 && res.body.platform === 'instagram') {
      console.log(`PASSED ✓ (Connected: ${res.body.connected}, Cookies: ${res.body.cookieCount})`);
      passed++;
    } else {
      console.log('FAILED ✗', res);
      failed++;
    }
  } catch (e) {
    console.log('FAILED ✗', e.message);
    failed++;
  }

  // Test 4: Live Viewport Screenshot
  try {
    process.stdout.write('[TEST 4] POST /api/browser/screenshot ... ');
    const res = await makeRequest('POST', '/api/browser/screenshot', {});
    if (res.status === 200 && res.body.screenshot && res.body.screenshot.length > 1000) {
      console.log(`PASSED ✓ (Title: "${res.body.title}", Base64 size: ${res.body.screenshot.length} bytes)`);
      passed++;
    } else {
      console.log('FAILED ✗', res);
      failed++;
    }
  } catch (e) {
    console.log('FAILED ✗', e.message);
    failed++;
  }

  // Test 5: Open Login Route
  try {
    process.stdout.write('[TEST 5] POST /api/browser/open-login (Instagram) ... ');
    const res = await makeRequest('POST', '/api/browser/open-login', { platform: 'instagram' });
    if (res.status === 200 && res.body.success) {
      console.log('PASSED ✓ (Desktop URL: ' + res.body.desktopUrl + ')');
      passed++;
    } else {
      console.log('FAILED ✗', res);
      failed++;
    }
  } catch (e) {
    console.log('FAILED ✗', e.message);
    failed++;
  }

  // Test 6: Query Data Store
  try {
    process.stdout.write('[TEST 6] GET /api/data ... ');
    const res = await makeRequest('GET', '/api/data');
    if (res.status === 200 && Array.isArray(res.body.items)) {
      console.log(`PASSED ✓ (Total stored items: ${res.body.total})`);
      passed++;
    } else {
      console.log('FAILED ✗', res);
      failed++;
    }
  } catch (e) {
    console.log('FAILED ✗', e.message);
    failed++;
  }

  // Test 7: MCP Protocol Stdio Server
  try {
    process.stdout.write('[TEST 7] MCP Server Stdio JSON-RPC (tools/list) ... ');
    const mcpRes = await runMcpTest();
    if (mcpRes.result?.tools?.length >= 5) {
      console.log(`PASSED ✓ (${mcpRes.result.tools.length} MCP tools exposed: ${mcpRes.result.tools.map(t => t.name).join(', ')})`);
      passed++;
    } else {
      console.log('FAILED ✗', mcpRes);
      failed++;
    }
  } catch (e) {
    console.log('FAILED ✗', e.message);
    failed++;
  }

  // Test 8: Custom URL Normalization (natgeo resolution without NXDOMAIN)
  try {
    process.stdout.write('[TEST 8] POST /api/browser/screenshot (target: natgeo) ... ');
    const res = await makeRequest('POST', '/api/browser/screenshot', { url: 'natgeo' });
    if (res.status === 200 && res.body.url && !res.body.url.includes('chrome-error')) {
      console.log(`PASSED ✓ (Resolved URL: "${res.body.url}", Title: "${res.body.title}")`);
      passed++;
    } else {
      console.log('FAILED ✗', res.body);
      failed++;
    }
  } catch (e) {
    console.log('FAILED ✗', e.message);
    failed++;
  }

  // Test 9: Real-time Screen & DOM Analysis
  try {
    process.stdout.write('[TEST 9] GET /api/browser/analyze ... ');
    const res = await makeRequest('GET', '/api/browser/analyze');
    if (res.status === 200 && res.body.success && res.body.pageType) {
      console.log(`PASSED ✓ (Classification: ${res.body.pageType}, Inputs found: ${res.body.detectedInputs?.length || 0})`);
      passed++;
    } else {
      console.log('FAILED ✗', res);
      failed++;
    }
  } catch (e) {
    console.log('FAILED ✗', e.message);
    failed++;
  }

  // Test 10: Conversational AI Agent Chat
  try {
    process.stdout.write('[TEST 10] POST /api/agent/chat ("What is currently on the screen?") ... ');
    const res = await makeRequest('POST', '/api/agent/chat', { message: 'What is currently on the screen?' });
    if (res.status === 200 && res.body.success && res.body.action === 'screen_analyzed' && res.body.text && res.body.text.length > 10) {
      console.log('PASSED ✓ (Agent responded with visual screen analysis & screenshot)');
      passed++;
    } else {
      console.log('FAILED ✗', res);
      failed++;
    }
  } catch (e) {
    console.log('FAILED ✗', e.message);
    failed++;
  }

  // Test 11: Direct Browser Input Simulation
  try {
    process.stdout.write('[TEST 11] POST /api/browser/input (action: key "Return") ... ');
    const res = await makeRequest('POST', '/api/browser/input', { action: 'key', key: 'Return' });
    if (res.status === 200 && res.body.success) {
      console.log(`PASSED ✓ (Key executed on VM display, current URL: "${res.body.url}")`);
      passed++;
    } else {
      console.log('FAILED ✗', res);
      failed++;
    }
  } catch (e) {
    console.log('FAILED ✗', e.message);
    failed++;
  }

  console.log('\n=====================================================');
  console.log(`📊 STRESS TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('=====================================================');

  if (failed === 0) {
    console.log('🎉 ALL SYSTEMS ARE OPERATIONAL AND VERIFIED!');
  } else {
    process.exit(1);
  }
}

stressTest();
