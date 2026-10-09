const fs = require('fs');
const path = require('path');
const config = require('./config');

if (!fs.existsSync(config.dataDir)) {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

const ITEMS_FILE = path.join(config.dataDir, 'collected_items.json');
const SESSIONS_FILE = path.join(config.dataDir, 'sessions.json');
const JOBS_FILE = path.join(config.dataDir, 'jobs.json');
const ACCOUNTS_FILE = path.join(config.dataDir, 'accounts.json');

const PLATFORM_META = {
  instagram: { label: 'Instagram', site: 'instagram.com' },
  twitter: { label: 'X (Twitter)', site: 'x.com' },
  linkedin: { label: 'LinkedIn', site: 'linkedin.com' },
  reddit: { label: 'Reddit', site: 'reddit.com' }
};

const DEFAULT_HOW_TO = {
  instagram: [
    { title: 'Browse a profile', example: 'Open @natgeo on Instagram' },
    { title: 'Collect posts', example: 'Get 10 posts from @openai with photos and captions' },
    { title: 'Check session', example: 'Am I logged into Instagram?' }
  ],
  twitter: [
    { title: 'Open a profile', example: 'Go to @openai on X' },
    { title: 'Check session', example: 'Check if X is logged in' }
  ],
  linkedin: [
    { title: 'Open feed', example: 'Go to linkedin.com feed' },
    { title: 'Check session', example: 'Verify my LinkedIn login' }
  ],
  reddit: [
    { title: 'Open subreddit', example: 'Go to reddit.com/r/technology' },
    { title: 'Check session', example: 'Am I logged into Reddit?' }
  ]
};

function loadJson(file, fallback) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (e) {
    console.error(`Error reading ${file}:`, e.message);
  }
  return fallback;
}

function saveJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error(`Error writing ${file}:`, e.message);
  }
}

class DataStore {
  constructor() {
    this.items = loadJson(ITEMS_FILE, []);
    this.sessions = loadJson(SESSIONS_FILE, {
      instagram: { connected: false, username: null, lastVerified: null },
      twitter: { connected: false, username: null, lastVerified: null },
      linkedin: { connected: false, username: null, lastVerified: null },
      reddit: { connected: false, username: null, lastVerified: null }
    });
    this.jobs = loadJson(JOBS_FILE, []);
    this.accountMemory = loadJson(ACCOUNTS_FILE, {});
    this.lastAgentPayload = null;
    this.listeners = [];
  }

  setLastAgentPayload(payload) {
    this.lastAgentPayload = payload;
    this.notify('agent_result', payload);
  }

  getLastAgentPayload() {
    return this.lastAgentPayload;
  }

  ensureAccountMemory(platform) {
    if (!this.accountMemory[platform]) {
      const meta = PLATFORM_META[platform] || { label: platform, site: platform };
      this.accountMemory[platform] = {
        label: meta.label,
        site: meta.site,
        howToUse: [...(DEFAULT_HOW_TO[platform] || [])],
        history: []
      };
      saveJson(ACCOUNTS_FILE, this.accountMemory);
    }
    return this.accountMemory[platform];
  }

  recordAccountActivity(platform, { action, detail }) {
    if (!platform) return;
    const mem = this.ensureAccountMemory(platform);
    mem.history = mem.history || [];
    mem.history.unshift({
      at: new Date().toISOString(),
      action: action || 'action',
      detail: detail || ''
    });
    if (mem.history.length > 40) mem.history.length = 40;
    saveJson(ACCOUNTS_FILE, this.accountMemory);
    this.notify('account_updated', { platform });
  }

  rememberHowToAsk(platform, { title, example }) {
    if (!platform || !example) return;
    const mem = this.ensureAccountMemory(platform);
    const exists = (mem.howToUse || []).some((h) => h.example.toLowerCase() === example.toLowerCase());
    if (!exists) {
      mem.howToUse = mem.howToUse || [];
      mem.howToUse.unshift({
        title: title || 'Custom task',
        example,
        learnedAt: new Date().toISOString()
      });
      if (mem.howToUse.length > 12) mem.howToUse.length = 12;
      saveJson(ACCOUNTS_FILE, this.accountMemory);
      this.notify('account_updated', { platform });
    }
  }

  getAccountProfiles() {
    const profiles = [];
    for (const [platform, session] of Object.entries(this.sessions)) {
      if (!session.connected) continue;
      const mem = this.ensureAccountMemory(platform);
      const meta = PLATFORM_META[platform] || { label: platform, site: platform };
      profiles.push({
        id: platform,
        label: mem.label || meta.label,
        site: mem.site || meta.site,
        username: session.username,
        connected: true,
        lastVerified: session.lastVerified,
        cookieCount: session.cookieCount,
        howToUse: mem.howToUse || [],
        history: (mem.history || []).slice(0, 15)
      });
    }
    return profiles;
  }

  onUpdate(fn) {
    this.listeners.push(fn);
  }

  notify(event, payload) {
    for (const fn of this.listeners) {
      try { fn(event, payload); } catch (e) { console.error('Listener error:', e); }
    }
  }

  addItem(item) {
    const record = {
      id: item.id || `item_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      platform: item.platform || 'web',
      target: item.target || 'general',
      type: item.type || 'post', // 'text' | 'image' | 'video' | 'post' | 'profile' | 'comment'
      title: item.title || '',
      caption: item.caption || item.text || '',
      author: item.author || '',
      mediaUrl: item.mediaUrl || null,
      thumbnailUrl: item.thumbnailUrl || null,
      metrics: {
        likes: item.likes ?? item.metrics?.likes ?? 0,
        comments: item.comments ?? item.metrics?.comments ?? 0,
        shares: item.shares ?? item.metrics?.shares ?? 0,
        views: item.views ?? item.metrics?.views ?? 0,
        timestamp: item.timestamp || new Date().toISOString()
      },
      rawDetails: item.rawDetails || {},
      collectedAt: new Date().toISOString()
    };

    // Prevent duplicates if url or id matches
    const existingIndex = this.items.findIndex(i => (i.id === record.id) || (record.mediaUrl && i.mediaUrl === record.mediaUrl));
    if (existingIndex >= 0) {
      this.items[existingIndex] = { ...this.items[existingIndex], ...record };
    } else {
      this.items.unshift(record);
    }

    saveJson(ITEMS_FILE, this.items);
    this.notify('item_added', record);
    return record;
  }

  addItems(items) {
    return items.map(item => this.addItem(item));
  }

  getItems(filters = {}) {
    let result = [...this.items];
    if (filters.platform && filters.platform !== 'all') {
      result = result.filter(i => i.platform.toLowerCase() === filters.platform.toLowerCase());
    }
    if (filters.type && filters.type !== 'all') {
      result = result.filter(i => i.type.toLowerCase() === filters.type.toLowerCase());
    }
    if (filters.target) {
      result = result.filter(i => i.target.toLowerCase().includes(filters.target.toLowerCase()));
    }
    if (filters.search) {
      const q = filters.search.toLowerCase();
      result = result.filter(i =>
        (i.caption && i.caption.toLowerCase().includes(q)) ||
        (i.title && i.title.toLowerCase().includes(q)) ||
        (i.author && i.author.toLowerCase().includes(q))
      );
    }
    return result;
  }

  deleteItem(id) {
    this.items = this.items.filter(i => i.id !== id);
    saveJson(ITEMS_FILE, this.items);
    this.notify('item_deleted', { id });
  }

  clearItems() {
    this.items = [];
    saveJson(ITEMS_FILE, this.items);
    this.notify('items_cleared', {});
  }

  setSession(platform, data) {
    const prev = this.sessions[platform] || {};
    this.sessions[platform] = {
      ...prev,
      ...data,
      lastUpdated: new Date().toISOString()
    };
    saveJson(SESSIONS_FILE, this.sessions);
    if (data.connected && !prev.connected) {
      this.ensureAccountMemory(platform);
      this.recordAccountActivity(platform, {
        action: 'connected',
        detail: `Logged in as ${data.username || 'active session'}`
      });
    }
    this.notify('session_updated', { platform, session: this.sessions[platform] });
    return this.sessions[platform];
  }

  getSessions() {
    return this.sessions;
  }

  createJob(job) {
    const record = {
      id: `job_${Date.now()}`,
      status: 'pending', // pending, running, completed, failed
      progress: 0,
      totalExpected: job.depth || 10,
      collectedCount: 0,
      platform: job.platform,
      target: job.target,
      dataTypes: job.dataTypes || ['text', 'images', 'metrics'],
      startedAt: new Date().toISOString(),
      logs: []
    };
    this.jobs.unshift(record);
    saveJson(JOBS_FILE, this.jobs);
    this.notify('job_created', record);
    return record;
  }

  updateJob(id, updates) {
    const index = this.jobs.findIndex(j => j.id === id);
    if (index >= 0) {
      this.jobs[index] = { ...this.jobs[index], ...updates };
      saveJson(JOBS_FILE, this.jobs);
      this.notify('job_updated', this.jobs[index]);
      return this.jobs[index];
    }
    return null;
  }

  addJobLog(id, message) {
    const job = this.jobs.find(j => j.id === id);
    if (job) {
      job.logs = job.logs || [];
      job.logs.push(`[${new Date().toLocaleTimeString()}] ${message}`);
      if (job.logs.length > 100) job.logs.shift();
      saveJson(JOBS_FILE, this.jobs);
      this.notify('job_log', { id, log: message });
    }
  }

  getJobs() {
    return this.jobs;
  }
}

module.exports = new DataStore();
