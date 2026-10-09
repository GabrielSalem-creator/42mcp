const boxdClient = require('./boxdClient');
const dataStore = require('./dataStore');

class ScraperEngine {
  constructor() {
    this.activeJobs = new Map();
  }

  async runJob(jobConfig) {
    const job = dataStore.createJob(jobConfig);
    const jobId = job.id;
    this.activeJobs.set(jobId, job);

    // Run asynchronously
    (async () => {
      try {
        dataStore.updateJob(jobId, { status: 'running', progress: 10 });
        dataStore.addJobLog(jobId, `Starting scraping job for target: ${jobConfig.target} on ${jobConfig.platform}`);

        if (jobConfig.platform === 'instagram') {
          await this.scrapeInstagram(jobId, jobConfig);
        } else {
          await this.scrapeGeneric(jobId, jobConfig);
        }

        dataStore.updateJob(jobId, { status: 'completed', progress: 100 });
        dataStore.addJobLog(jobId, `Job completed successfully!`);
      } catch (err) {
        console.error(`Scrape job ${jobId} failed:`, err);
        dataStore.updateJob(jobId, { status: 'failed', error: err.message });
        dataStore.addJobLog(jobId, `Job failed: ${err.message}`);
      } finally {
        this.activeJobs.delete(jobId);
      }
    })();

    return job;
  }

  async scrapeInstagram(jobId, config) {
    const target = config.target;
    const depth = parseInt(config.depth, 10) || 10;
    const typesStr = Array.isArray(config.dataTypes) ? config.dataTypes.join(',') : (config.dataTypes || 'text,images,videos,metrics');

    dataStore.addJobLog(jobId, `Launching VM browser runner with depth=${depth}, types=${typesStr}...`);
    dataStore.updateJob(jobId, { progress: 30 });

    const cmd = `python3 /home/boxd/vm_agent_controller.py scrape-instagram "${target}" --types "${typesStr}" --depth ${depth}`;
    const res = await boxdClient.exec(cmd, undefined, 120000);

    dataStore.updateJob(jobId, { progress: 70 });
    dataStore.addJobLog(jobId, `Parsing collected output from VM...`);

    if (res.exitCode !== 0 && !res.stdout.trim()) {
      throw new Error(res.stderr || `Runner failed with exit code ${res.exitCode}`);
    }

    let parsed;
    try {
      const jsonStart = res.stdout.indexOf('{');
      const jsonStr = jsonStart >= 0 ? res.stdout.slice(jsonStart) : res.stdout;
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      throw new Error(`Failed to parse VM scraper JSON: ${e.message}\nRaw: ${res.stdout.slice(0, 300)}`);
    }

    if (!parsed.success) {
      throw new Error(parsed.error || 'Scraper reported error');
    }

    const items = parsed.items || [];
    dataStore.addJobLog(jobId, `Found ${items.length} items. Storing in database...`);

    for (const item of items) {
      dataStore.addItem({
        ...item,
        platform: 'instagram',
        target: target
      });
    }

    // If Instagram profile returned avatar / bio, save profile record
    if (parsed.profile && parsed.profile.username) {
      dataStore.addItem({
        id: `profile_${parsed.profile.username}`,
        platform: 'instagram',
        target: target,
        type: 'profile',
        title: `Profile: @${parsed.profile.username}`,
        caption: parsed.profile.bio || `Instagram profile for @${parsed.profile.username}`,
        author: parsed.profile.username,
        mediaUrl: parsed.profile.avatarUrl,
        thumbnailUrl: parsed.profile.avatarUrl,
        metrics: {
          postsCount: items.length
        },
        rawDetails: parsed.profile
      });
    }

    dataStore.updateJob(jobId, {
      progress: 95,
      collectedCount: items.length
    });

    dataStore.recordAccountActivity('instagram', {
      action: 'extract',
      detail: `${items.length} items from @${target}`
    });
  }

  async scrapeDirect({ platform = 'instagram', target, depth = 8, dataTypes = ['text', 'images', 'videos', 'metrics'] }) {
    const typesStr = Array.isArray(dataTypes) ? dataTypes.join(',') : (dataTypes || 'text,images,videos,metrics');
    let cleanTarget = (target || '').trim();
    if (cleanTarget.startsWith('@')) cleanTarget = cleanTarget.slice(1);

    if (platform === 'instagram' && cleanTarget.toLowerCase() === 'mcgill') {
      cleanTarget = 'mcgillu';
    }

    const cmd = `python3 /home/boxd/vm_agent_controller.py scrape-instagram "${cleanTarget}" --types "${typesStr}" --depth ${depth}`;
    const res = await boxdClient.exec(cmd, undefined, 120000);

    let parsed = {};
    try {
      const jsonStart = res.stdout.indexOf('{');
      const jsonStr = jsonStart >= 0 ? res.stdout.slice(jsonStart) : res.stdout;
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      throw new Error(`Scraper execution error: ${e.message}`);
    }

    if (!parsed.success) {
      throw new Error(parsed.error || 'Scraper failed');
    }

    const items = parsed.items || [];
    for (const item of items) {
      dataStore.addItem({
        ...item,
        platform: 'instagram',
        target: cleanTarget
      });
    }

    if (parsed.profile && parsed.profile.username) {
      dataStore.addItem({
        id: `profile_${parsed.profile.username}`,
        platform: 'instagram',
        target: cleanTarget,
        type: 'profile',
        title: `Profile: @${parsed.profile.username}`,
        caption: parsed.profile.bio || `Instagram profile for @${parsed.profile.username}`,
        author: parsed.profile.username,
        mediaUrl: parsed.profile.avatar,
        thumbnailUrl: parsed.profile.avatar,
        metrics: {
          postsCount: items.length
        },
        rawDetails: parsed.profile
      });
    }

    return parsed;
  }

  async searchInstagramProfiles({ query, nameContains, limit = 25 }) {
    const q = (query || '').trim().replace(/"/g, '');
    const contains = (nameContains || query || '').trim().replace(/"/g, '');
    const lim = Math.min(Math.max(parseInt(limit, 10) || 25, 5), 40);
    const cmd = `python3 /home/boxd/vm_agent_controller.py search-instagram ${JSON.stringify(q)} --limit ${lim} --contains ${JSON.stringify(contains)}`;
    const res = await boxdClient.exec(cmd, undefined, 180000);

    let parsed = {};
    try {
      const jsonStart = res.stdout.indexOf('{');
      const jsonStr = jsonStart >= 0 ? res.stdout.slice(jsonStart) : res.stdout;
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      throw new Error(`Instagram search parse error: ${e.message}`);
    }

    if (!parsed.success) {
      throw new Error(parsed.error || 'Instagram search failed');
    }

    dataStore.recordAccountActivity('instagram', {
      action: 'search',
      detail: `query=${q} found=${parsed.count || 0} (filter: ${contains})`
    });

    return parsed;
  }

  async scrapeStoriesDirect({ target, maxStories = 15 }) {
    let cleanTarget = (target || '').trim().replace(/^@/, '');
    if (cleanTarget.toLowerCase() === 'mcgill') cleanTarget = 'mcgillu';

    const cmd = `python3 /home/boxd/vm_agent_controller.py scrape-instagram-stories "${cleanTarget}" --max ${maxStories}`;
    const res = await boxdClient.exec(cmd, undefined, 120000);

    const jsonStart = res.stdout.indexOf('{');
    const jsonStr = jsonStart >= 0 ? res.stdout.slice(jsonStart) : res.stdout;
    const parsed = JSON.parse(jsonStr);

    if (!parsed.success) {
      throw new Error(parsed.error || 'Story scrape failed');
    }

    for (const item of parsed.items || []) {
      dataStore.addItem({ ...item, platform: 'instagram', target: cleanTarget });
    }

    dataStore.recordAccountActivity('instagram', {
      action: 'stories',
      detail: `${parsed.storyCount || 0} story/highlight images @${cleanTarget}`
    });

    return parsed;
  }

  async scrapeProfileAndStories({ target, depth = 15, maxStories = 15 }) {
    const profile = await this.scrapeDirect({
      platform: 'instagram',
      target,
      depth,
      dataTypes: ['text', 'images', 'videos', 'metrics']
    });
    const stories = await this.scrapeStoriesDirect({ target, maxStories });
    return { profile, stories, combinedCount: (profile.count || 0) + (stories.storyCount || 0) };
  }

  async scrapeGeneric(jobId, config) {
    const target = config.target;
    dataStore.addJobLog(jobId, `Navigating VM browser to ${target}...`);
    dataStore.updateJob(jobId, { progress: 40 });

    const cmd = `python3 /home/boxd/vm_agent_controller.py screenshot --url "${target}"`;
    const res = await boxdClient.exec(cmd, undefined, 60000);

    let parsed;
    try {
      parsed = JSON.parse(res.stdout);
    } catch (e) {
      throw new Error(`Failed to parse screenshot response: ${e.message}`);
    }

    let authorHostname = target;
    try {
      const urlToParse = (target.startsWith('http://') || target.startsWith('https://'))
        ? target
        : `https://${target}`;
      authorHostname = new URL(urlToParse).hostname;
    } catch (_) {
      authorHostname = target;
    }

    dataStore.addItem({
      platform: config.platform || 'web',
      target: target,
      type: 'image',
      title: parsed.title || target,
      caption: `Captured snapshot of ${target}`,
      author: authorHostname,
      mediaUrl: `data:image/jpeg;base64,${parsed.screenshot}`,
      thumbnailUrl: `data:image/jpeg;base64,${parsed.screenshot}`,
      metrics: {
        timestamp: new Date().toISOString()
      },
      rawDetails: {
        url: parsed.url,
        title: parsed.title
      }
    });

    dataStore.updateJob(jobId, { progress: 95, collectedCount: 1 });
  }

  async verifyLogin(platform) {
    const cmd = `python3 /home/boxd/vm_agent_controller.py check-login ${platform}`;
    const res = await boxdClient.exec(cmd, undefined, 60000);
    try {
      const jsonStart = res.stdout.indexOf('{');
      const jsonStr = jsonStart >= 0 ? res.stdout.slice(jsonStart) : res.stdout;
      const data = JSON.parse(jsonStr);
      dataStore.setSession(platform, {
        connected: data.connected,
        username: data.username,
        cookieCount: data.cookieCount,
        lastVerified: new Date().toISOString()
      });
      return data;
    } catch (e) {
      return { platform, connected: false, error: e.message };
    }
  }

  async openLoginWindow(platform) {
    const cmd = `python3 /home/boxd/vm_agent_controller.py open-login ${platform}`;
    const res = await boxdClient.exec(cmd, undefined, 60000);
    try {
      return JSON.parse(res.stdout);
    } catch (e) {
      return { status: 'opened', raw: res.stdout };
    }
  }
}

module.exports = new ScraperEngine();
