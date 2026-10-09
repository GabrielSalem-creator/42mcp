const boxdClient = require('./boxdClient');

const DISPLAY_PREFIX = 'export DISPLAY=:100; ';

function withDisplay(command) {
  const trimmed = (command || '').trim();
  if (trimmed.startsWith('export DISPLAY=')) return trimmed;
  return DISPLAY_PREFIX + trimmed;
}

async function vmBrowserExec(shellFragment, timeoutMs = 15000) {
  return boxdClient.exec(withDisplay(shellFragment), undefined, timeoutMs);
}

function parseVmJson(stdout) {
  const raw = (stdout || '').trim();
  if (!raw) return {};
  const start = raw.indexOf('{');
  if (start < 0) {
    throw new Error(`No JSON in VM output: ${raw.slice(0, 200)}`);
  }
  return JSON.parse(raw.slice(start));
}

async function vmScreenshot(timeoutMs = 25000) {
  const res = await boxdClient.exec(
    'python3 /home/boxd/vm_agent_controller.py screenshot',
    undefined,
    timeoutMs
  );
  return parseVmJson(res.stdout);
}

module.exports = {
  withDisplay,
  vmBrowserExec,
  parseVmJson,
  vmScreenshot
};
