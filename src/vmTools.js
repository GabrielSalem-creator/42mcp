const boxdClient = require('./boxdClient');
const { vmBrowserExec } = require('./vmBrowserExec');
const scraperEngine = require('./scraperEngine');
const dataStore = require('./dataStore');
const screenAnalyzer = require('./screenAnalyzer');

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'vm_check_login',
      description: 'Check if Instagram, Twitter/X, or LinkedIn has an active session on the VM browser.',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: ['instagram', 'twitter', 'linkedin'], description: 'Site to check' }
        },
        required: ['platform']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'vm_navigate',
      description: 'Open a URL or site name in the VM browser (e.g. natgeo, https://instagram.com/mcgillu).',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'URL, @handle, or site keyword' },
          platform: { type: 'string', enum: ['web', 'instagram', 'twitter', 'linkedin'], default: 'web' }
        },
        required: ['target']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'vm_scrape_instagram',
      description: 'Scrape an Instagram profile: posts, captions, images, reels, profile bio, highlights metadata. Uses logged-in session.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Username without @ (mcgill -> mcgillu auto)' },
          depth: { type: 'integer', description: 'Max posts to collect', default: 12 },
          include_stories_metadata: { type: 'boolean', default: true }
        },
        required: ['target']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'vm_screen_analyze',
      description: 'Read current VM browser URL, title, and visible form fields (login/2FA detection).',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'vm_type_text',
      description: 'Type text into the focused field on the VM browser.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'vm_press_key',
      description: 'Press a key (Return, Tab, Escape, etc.) in the VM browser.',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'vm_scroll',
      description: 'Scroll the VM browser page up or down.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down'] }
        },
        required: ['direction']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'vm_list_saved_data',
      description: 'List recently collected items stored on the server.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', default: 10 },
          target: { type: 'string', description: 'Filter by username/target' }
        }
      }
    }
  }
];

async function vmNavigate(target, platform = 'web') {
  const safe = String(target).replace(/"/g, '\\"');
  const cmd = `python3 /home/boxd/vm_agent_controller.py screenshot --url "${safe}" --platform "${platform}"`;
  const res = await boxdClient.exec(cmd, undefined, 90000);
  const parsed = JSON.parse(res.stdout);
  return {
    url: parsed.url,
    title: parsed.title,
    errorNotice: parsed.errorNotice || null
  };
}

async function executeTool(name, args = {}) {
  switch (name) {
    case 'vm_check_login': {
      const platform = args.platform || 'instagram';
      const status = await scraperEngine.verifyLogin(platform);
      return { platform, ...status };
    }
    case 'vm_navigate': {
      const platform = args.platform || 'web';
      const out = await vmNavigate(args.target, platform);
      dataStore.recordAccountActivity(platform === 'web' ? 'instagram' : platform, {
        action: 'navigate',
        detail: out.url || args.target
      });
      return out;
    }
    case 'vm_scrape_instagram': {
      let target = String(args.target || '').replace(/^@/, '');
      const depth = Math.min(30, Math.max(1, parseInt(args.depth, 10) || 12));
      const parsed = await scraperEngine.scrapeDirect({
        platform: 'instagram',
        target,
        depth,
        dataTypes: ['text', 'images', 'videos', 'metrics']
      });
      const profile = parsed.profile || {};
      dataStore.recordAccountActivity('instagram', {
        action: 'extract',
        detail: `${parsed.count || 0} items @${profile.username || target}`
      });
      return {
        success: parsed.success,
        count: parsed.count,
        requiresLogin: parsed.requiresLogin,
        profile: {
          username: profile.username,
          bio: profile.bio,
          stats: profile.stats,
          hasActiveStory: profile.hasActiveStory,
          highlights: profile.highlights,
          url: profile.url
        },
        items: (parsed.items || []).slice(0, depth).map((i) => ({
          id: i.id,
          type: i.type,
          caption: (i.caption || '').slice(0, 200),
          postUrl: i.postUrl,
          mediaUrl: i.mediaUrl,
          metrics: i.metrics
        }))
      };
    }
    case 'vm_screen_analyze': {
      return await screenAnalyzer.analyzePage();
    }
    case 'vm_type_text': {
      const text = String(args.text || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      await vmBrowserExec(`agent-browser keyboard type "${text}"`, 20000);
      return { ok: true };
    }
    case 'vm_press_key': {
      const key = String(args.key || 'Return').replace(/[^a-zA-Z0-9_+ -]/g, '');
      await vmBrowserExec(`agent-browser press ${key}`, 12000);
      return { ok: true, key };
    }
    case 'vm_scroll': {
      const dy = args.direction === 'up' ? -500 : 500;
      await vmBrowserExec(`agent-browser mouse wheel ${dy}`, 12000);
      return { ok: true, direction: args.direction };
    }
    case 'vm_list_saved_data': {
      const limit = args.limit || 10;
      let items = dataStore.getItems({});
      if (args.target) {
        const t = args.target.toLowerCase();
        items = items.filter((i) => (i.target || '').toLowerCase().includes(t));
      }
      return {
        total: items.length,
        items: items.slice(0, limit).map((i) => ({
          id: i.id,
          type: i.type,
          target: i.target,
          author: i.author,
          caption: (i.caption || '').slice(0, 120),
          postUrl: i.postUrl,
          mediaUrl: i.mediaUrl
        }))
      };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

function extractInstagramTarget(raw, lower) {
  const handle = raw.match(/@([a-zA-Z0-9_.]+)/);
  if (handle) return handle[1];

  if (/mcgill/i.test(raw)) return 'mcgill';

  const from = raw.match(/(?:from|for|of|about|on)\s+@?([a-zA-Z0-9_.]+)/i);
  if (from) return from[1];

  const before = raw.match(/\b([a-zA-Z0-9_.]{2,})\s+(?:profile|profiles|stories|story|posts|reels|account)/i);
  if (before) return before[1];

  const getWord = raw.match(/(?:get|fetch|pull|scrape|collect|give)\s+(?:all\s+)?([a-zA-Z0-9_.]{2,})/i);
  const skip = new Set([
    'me',
    'all',
    'the',
    'instagram',
    'insta',
    'ig',
    'their',
    'them',
    'every',
    'each',
    'profiles',
    'profile',
    'stories',
    'story',
    'posts'
  ]);
  if (getWord && !skip.has(getWord[1].toLowerCase())) {
    return getWord[1];
  }

  const goIg = raw.match(/(?:go to|on|open)\s+instagram.*?([a-zA-Z0-9_.]{2,})/i);
  if (goIg && !skip.has(goIg[1].toLowerCase())) return goIg[1];

  return '';
}

function isInstagramDataRequest(lower) {
  const onIg = lower.includes('instagram') || lower.includes(' ig');
  const dataVerb = /(?:get|fetch|pull|scrape|collect|extract|download|give|show|go to)\b/.test(lower);
  const dataNoun = /(?:profile|profiel|profiles|stor(?:y|ies)|post|reel|feed|account|data|caption|photo|video)/.test(lower);
  return (onIg && (dataVerb || dataNoun)) || (dataVerb && dataNoun);
}

module.exports = {
  TOOL_DEFINITIONS,
  executeTool,
  extractInstagramTarget,
  isInstagramDataRequest
};
