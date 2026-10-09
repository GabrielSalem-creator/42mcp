const { spawn } = require('child_process');
const config = require('./config');

let Boxd = null;
try {
  ({ Boxd } = require('@boxd-sh/sdk'));
} catch (_) {
  Boxd = null;
}

/**
 * Runs a shell command locally (used when this server runs inside the VM).
 */
function execLocal(command, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], {
      env: { ...process.env, DISPLAY: process.env.DISPLAY || config.display },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch (_) {}
      resolve({ stdout, stderr: stderr + '\n[timeout]', exitCode: -1 });
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout, stderr: e.message, exitCode: -1 });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code == null ? -1 : code });
    });
  });
}

class BoxdClient {
  constructor() {
    this.defaultVm = config.defaultVmName;
    this.cachedMachine = null;
    this.local = config.localExec;
    this.boxd = null;
    if (Boxd && (config.apiKey || this.local)) {
      try {
        this.boxd = config.apiKey ? new Boxd({ apiKey: config.apiKey }) : new Boxd();
      } catch (e) {
        console.warn('[boxd] SDK init failed:', e.message);
        this.boxd = null;
      }
    }
  }

  syntheticMachine(name = this.defaultVm) {
    return {
      id: name,
      name,
      status: 'running',
      local: true,
      access: {
        url: config.publicBaseUrl || `https://${name}.boxd.sh`,
        desktopUrl: `https://app.boxd.sh/desktop/${name}`
      },
      resources: { vcpu: 2, memoryBytes: 8 * 1024 * 1024 * 1024 }
    };
  }

  async listMachines() {
    if (!this.boxd) return [this.syntheticMachine()];
    try {
      return await this.boxd.machines.list();
    } catch (e) {
      if (this.local) return [this.syntheticMachine()];
      console.error('Failed to list machines:', e.message);
      throw e;
    }
  }

  async getMachine(name = this.defaultVm) {
    if (!this.boxd) return this.local ? this.syntheticMachine(name) : null;
    try {
      const machine = await this.boxd.machines.get(name);
      this.cachedMachine = machine;
      return machine;
    } catch (e) {
      if (this.local) return this.syntheticMachine(name);
      console.warn(`Machine ${name} not found or error:`, e.message);
      return null;
    }
  }

  async ensureMachine(name = this.defaultVm) {
    let machine = await this.getMachine(name);
    if (!machine) {
      if (!this.boxd) throw new Error('Boxd SDK unavailable (missing BOXD_API_KEY)');
      console.log(`Machine ${name} does not exist, creating...`);
      machine = await this.boxd.machines.create({ name, restartPolicy: 'always' });
      console.log(`Waiting for ${name} to be ready...`);
      await this.boxd.machines.waitUntilReady(name, { timeout: 180000 });
      machine = await this.getMachine(name);
    }
    return machine;
  }

  /**
   * Run a shell command on the VM. Locally when VM_LOCAL=1, otherwise via Boxd API.
   */
  async exec(command, name = this.defaultVm, timeoutMs = 60000) {
    if (this.local) return execLocal(command, timeoutMs);
    if (!this.boxd) {
      return { stdout: '', stderr: 'Boxd SDK unavailable (missing BOXD_API_KEY)', exitCode: -1 };
    }
    try {
      const res = await this.boxd.machines.exec(name, { command, timeout: timeoutMs });
      return {
        stdout: res.stdout || '',
        stderr: res.stderr || '',
        exitCode: res.exitCode
      };
    } catch (e) {
      console.error(`Exec error on ${name}:`, e.message);
      return { stdout: '', stderr: e.message, exitCode: -1 };
    }
  }

  async startMachine(name = this.defaultVm) {
    if (!this.boxd) return this.syntheticMachine(name);
    await this.boxd.machines.start(name);
    return await this.getMachine(name);
  }

  async stopMachine(name = this.defaultVm) {
    if (!this.boxd) throw new Error('Not available in local mode');
    await this.boxd.machines.stop(name);
    return await this.getMachine(name);
  }

  async pauseMachine(name = this.defaultVm) {
    if (!this.boxd) throw new Error('Not available in local mode');
    return await this.boxd.machines.pause(name);
  }

  async resumeMachine(name = this.defaultVm) {
    if (!this.boxd) throw new Error('Not available in local mode');
    return await this.boxd.machines.resume(name);
  }

  async rebootMachine(name = this.defaultVm) {
    if (!this.boxd) throw new Error('Not available in local mode');
    await this.boxd.machines.reboot(name);
    return await this.getMachine(name);
  }

  async getDesktopUrl(name = this.defaultVm) {
    const machine = await this.getMachine(name);
    return machine?.access?.desktopUrl || `https://app.boxd.sh/desktop/${name}`;
  }

  async writeFile(filePath, content, name = this.defaultVm) {
    if (this.local) {
      const fs = require('fs');
      const path = require('path');
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
        return { stdout: '', stderr: '', exitCode: 0 };
      } catch (e) {
        return { stdout: '', stderr: e.message, exitCode: -1 };
      }
    }
    const base64 = Buffer.from(content, 'utf8').toString('base64');
    const cmd = `mkdir -p "$(dirname "${filePath}")" && echo "${base64}" | base64 -d > "${filePath}"`;
    return await this.exec(cmd, name);
  }

  async readFile(filePath, name = this.defaultVm) {
    if (this.local) {
      const fs = require('fs');
      try { return fs.readFileSync(filePath, 'utf8'); } catch (_) { return null; }
    }
    const cmd = `cat "${filePath}" 2>/dev/null | base64 -w 0`;
    const res = await this.exec(cmd, name);
    if (res.exitCode === 0 && res.stdout.trim()) {
      return Buffer.from(res.stdout.trim(), 'base64').toString('utf8');
    }
    return null;
  }
}

module.exports = new BoxdClient();
