const scraperEngine = require('./scraperEngine');
const dataStore = require('./dataStore');
const screenAnalyzer = require('./screenAnalyzer');
const { executeTool } = require('./vmTools');
const { parseIntent, expandClusterTargets } = require('./intentParser');
const { buildPayload, summarizeText } = require('./resultPayload');

async function collectInstagramTarget(target, { depth, wantsStories, wantsPosts }) {
  const clean = target.replace(/^@/, '');
  let profile = null;
  let stories = null;

  if (wantsPosts) {
    profile = await scraperEngine.scrapeDirect({
      platform: 'instagram',
      target: clean,
      depth,
      dataTypes: ['text', 'images', 'videos', 'metrics']
    });
  }
  if (wantsStories) {
    stories = await scraperEngine.scrapeStoriesDirect({ target: clean, maxStories: 25 });
  }

  const posts = profile?.items || [];
  const storyItems = (stories?.items || []).filter(
    (i) => i.mediaUrl && !String(i.mediaUrl).startsWith('blob:')
  );

  let profileRecord = null;
  if (profile?.profile?.username) {
    profileRecord = {
      id: `profile_${profile.profile.username}`,
      type: 'profile',
      platform: 'instagram',
      target: clean,
      author: profile.profile.username,
      caption: profile.profile.bio,
      mediaUrl: profile.profile.avatar,
      thumbnailUrl: profile.profile.avatar,
      rawDetails: profile.profile
    };
  }

  return {
    target: clean,
    platform: 'instagram',
    profile: profile?.profile || null,
    posts,
    stories: storyItems,
    postCount: posts.length,
    storyCount: storyItems.length,
    profileRecord,
    requiresLogin: profile?.requiresLogin
  };
}

async function runLocalVmAgent(userMessage) {
  const intent = parseIntent(userMessage);
  const { raw, lower } = { raw: intent.raw, lower: intent.raw.toLowerCase() };

  if (intent.isLoginCheck) {
    const platform = intent.platform;
    const status = await scraperEngine.verifyLogin(platform);
    return {
      text: status.connected
        ? `${platform}: logged in (${status.username || 'active'}).`
        : `${platform}: not logged in — use the screen, then Done.`,
      action: 'login_checked',
      status
    };
  }

  if (intent.isScreenQuery) {
    const analysis = await screenAnalyzer.analyzePage();
    return {
      text: `VM: ${analysis.title}\n${analysis.url}`,
      action: 'screen_analyzed',
      analysis
    };
  }

  if (intent.isNavigation) {
    const target = raw.replace(/^(open|go to|navigate)\s+/i, '').trim();
    const nav = await executeTool('vm_navigate', { target, platform: 'web' });
    return { text: `Opened ${nav.url || target}`, action: 'navigated', data: nav };
  }

  if (intent.platform === 'instagram' && (intent.wantsPosts || intent.wantsStories)) {
    const login = await scraperEngine.verifyLogin('instagram');
    if (!login.connected) {
      await executeTool('vm_navigate', { target: 'https://www.instagram.com/', platform: 'instagram' });
      return {
        text: 'Instagram not logged in on the VM. Sign in on the screen, tap Done, ask again.',
        action: 'login_required'
      };
    }

    let targets = [...intent.targets];
    let searchMeta = {};

    if (intent.discoverProfiles) {
      const q = intent.discoveryQuery;
      if (!q) {
        return {
          text:
            'Which keyword for profile search? Example: "all mcgill profiles with mcgill in their name and their stories".',
          action: 'need_target'
        };
      }
      try {
        const search = await scraperEngine.searchInstagramProfiles({
          query: q,
          nameContains: intent.nameContains || q,
          limit: intent.discoveryLimit
        });
        const found = search.profiles || [];
        const seeds =
          q === 'mcgill'
            ? ['mcgillu', 'mcgillmartlets', 'mcgillathletics', 'mcgillreporter']
            : [];
        targets = [...new Set([...seeds, ...targets, ...found])];
        searchMeta = {
          searchQuery: q,
          profilesDiscovered: found.length,
          nameFilter: intent.nameContains || q
        };
      } catch (err) {
        console.error('[agent] IG search failed, using seed list:', err.message);
      }
      if (targets.length < 3) {
        targets = [...new Set([...targets, ...expandClusterTargets(intent.raw, intent.raw.toLowerCase(), targets)])];
      }
    }

    if (!targets.length) {
      return {
        text:
          'Which Instagram account(s)? Example: @natgeo and @openai stories and posts — or "all mcgill profiles with mcgill in the name".',
        action: 'need_target'
      };
    }

    const maxTargets = intent.maxTargets || 5;
    const batch = targets.slice(0, maxTargets);
    const bulkMode = batch.length > 6;
    const runIntent = {
      ...intent,
      depth: bulkMode ? Math.min(intent.depth, 8) : intent.depth,
      wantsPosts: bulkMode && intent.wantsStories ? false : intent.wantsPosts
    };

    const results = [];
    for (const t of batch) {
      try {
        const block = await collectInstagramTarget(t, runIntent);
        results.push(block);
        dataStore.recordAccountActivity('instagram', {
          action: 'extract',
          detail: `@${block.target} posts=${block.postCount} stories=${block.storyCount}`
        });
      } catch (err) {
        results.push({
          target: t,
          platform: 'instagram',
          error: err.message,
          posts: [],
          stories: [],
          postCount: 0,
          storyCount: 0
        });
      }
    }

    const payload = buildPayload({ request: raw, results, meta: searchMeta });
    dataStore.setLastAgentPayload(payload);
    dataStore.rememberHowToAsk('instagram', { title: 'Collection', example: raw });

    return {
      text: summarizeText(payload),
      action: 'collection_complete',
      payload,
      discoveredProfiles: searchMeta.profilesDiscovered
    };
  }

  if (intent.targets.length && intent.platform === 'instagram') {
    const login = await scraperEngine.verifyLogin('instagram');
    if (login.connected) {
      const block = await collectInstagramTarget(intent.targets[0], {
        ...intent,
        wantsPosts: true,
        wantsStories: true
      });
      const payload = buildPayload({ request: raw, results: [block] });
      dataStore.setLastAgentPayload(payload);
      return { text: summarizeText(payload), action: 'collection_complete', payload };
    }
  }

  const analysis = await screenAnalyzer.analyzePage();
  return {
    text: `VM is on: ${analysis.url}\nAsk for any @account on Instagram (or other site): posts, stories, highlights — e.g. "@nasa stories and posts".`,
    action: 'vm_status',
    analysis
  };
}

module.exports = { runLocalVmAgent, collectInstagramTarget };
