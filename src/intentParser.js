const { extractInstagramTarget } = require('./vmTools');

/** Fallback seeds if Instagram search returns few hits */
const ENTITY_IG_CLUSTERS = {
  mcgill: ['mcgillu', 'mcgillmartlets', 'mcgillathletics', 'mcgillreporter'],
  nasa: ['nasa', 'nasahubble', 'nasajpl'],
  natgeo: ['natgeo', 'natgeoyourshot', 'natgeowild']
};

const PLATFORM_ALIASES = {
  instagram: ['instagram', ' ig', 'insta'],
  twitter: ['twitter', ' x.com', ' on x'],
  linkedin: ['linkedin']
};

function detectPlatform(lower) {
  if (PLATFORM_ALIASES.linkedin.some((k) => lower.includes(k))) return 'linkedin';
  if (PLATFORM_ALIASES.twitter.some((k) => lower.includes(k))) return 'twitter';
  if (PLATFORM_ALIASES.instagram.some((k) => lower.includes(k))) return 'instagram';
  return 'instagram';
}

function parseTargets(raw, lower) {
  const handles = new Set();
  for (const m of raw.matchAll(/@([a-zA-Z0-9_.]{2,})/g)) {
    handles.add(m[1]);
  }
  const single = extractInstagramTarget(raw, lower);
  if (single) handles.add(single.replace(/^@/, ''));
  const quoted = raw.match(/["'](@?[a-zA-Z0-9_.]+)["']/g);
  if (quoted) {
    quoted.forEach((q) => {
      const h = q.replace(/["']/g, '').replace(/^@/, '');
      if (h.length > 1) handles.add(h);
    });
  }
  return [...handles];
}

function extractDiscoveryQuery(raw, lower) {
  const inName = raw.match(/(?:have|with)\s+([a-z0-9_.]+)\s+in\s+(?:their\s+)?name/i);
  if (inName) return inName[1].toLowerCase();

  const allProf = raw.match(/\ball\s+(?:the\s+)?([a-z][a-z0-9]*)\s+(?:\w+\s+){0,6}profiles/i);
  if (allProf) return allProf[1].toLowerCase();

  for (const key of Object.keys(ENTITY_IG_CLUSTERS)) {
    if (new RegExp(`\\b${key}\\b`, 'i').test(raw)) return key;
  }
  return null;
}

function extractNameContains(raw, lower, discoveryQuery) {
  const inName = raw.match(/(?:have|with)\s+([a-z0-9_.]+)\s+in\s+(?:their\s+)?name/i);
  if (inName) return inName[1].toLowerCase();
  if (/in\s+(?:their\s+)?name/.test(lower) && discoveryQuery) return discoveryQuery;
  return null;
}

function wantsProfileDiscovery(raw, lower) {
  const many =
    /\bprofiles\b|\baccounts\b|\bevery\b|\beach\b|\brelated\b/.test(lower) ||
    /\ball\s+(?:the\s+)?[a-z]/i.test(lower);
  const nameFilter = /in\s+(?:their\s+)?name/.test(lower) || /with\s+[a-z0-9]+\s+in/.test(lower);
  return many && (nameFilter || /\bsearch\b/.test(lower) || extractDiscoveryQuery(raw, lower));
}

function expandClusterTargets(raw, lower, targets) {
  const wantsMany =
    /\bprofiles\b|\baccounts\b|\bevery\b|\beach\b|\brelated\b/.test(lower) ||
    /\ball\s+(?:the\s+)?[a-z]/i.test(lower);
  const out = new Set(targets.map((t) => t.replace(/^@/, '').toLowerCase()));

  for (const [needle, handles] of Object.entries(ENTITY_IG_CLUSTERS)) {
    if (!lower.includes(needle)) continue;
    const mentioned =
      out.has(needle) ||
      targets.some((t) => t.toLowerCase().includes(needle)) ||
      (wantsMany && new RegExp(`\\b${needle}\\b`, 'i').test(raw));
    if (!mentioned) continue;
    out.delete(needle);
    for (const h of handles) out.add(h.toLowerCase());
  }

  return [...out];
}

function parseIntent(userMessage) {
  const raw = (userMessage || '').trim();
  const lower = raw.toLowerCase();
  const platform = detectPlatform(lower);
  const discoverProfiles = wantsProfileDiscovery(raw, lower);
  const discoveryQuery = extractDiscoveryQuery(raw, lower);
  const nameContains = extractNameContains(raw, lower, discoveryQuery);

  let targets = parseTargets(raw, lower);
  if (!discoverProfiles) {
    targets = expandClusterTargets(raw, lower, targets);
  }

  const wantsStories = /stor(?:y|ies)|highlight/.test(lower);
  const wantsPosts =
    /post|reel|feed|profile|caption|photo|video|grid|all\b|everything/.test(lower) ||
    (!wantsStories && /get|fetch|collect|scrape|pull|give|download|extract/.test(lower));

  const depthMatch = raw.match(/(\d+)\s*(?:posts|items|stories|reels|profiles)?/i);
  const depth = depthMatch
    ? parseInt(depthMatch[1], 10)
    : lower.includes('all') || lower.includes('everything')
      ? 25
      : 15;

  const maxStories = lower.includes('all') ? 25 : 15;
  const discoveryLimit = lower.includes('all') ? 30 : 22;
  const maxTargets = discoverProfiles ? 15 : 5;
  const hasDataAsk = wantsStories || wantsPosts || targets.length > 0 || discoverProfiles;
  const startsNav = /^(open|go to|navigate)\s+/i.test(raw);

  return {
    raw,
    platform,
    targets,
    discoverProfiles,
    discoveryQuery,
    nameContains,
    discoveryLimit,
    maxTargets,
    wantsStories,
    wantsPosts: wantsPosts || targets.length > 0 || discoverProfiles,
    depth,
    maxStories,
    isNavigation: startsNav && !hasDataAsk,
    isLoginCheck: /logged|login|session|signed in/.test(lower),
    isScreenQuery: /what(?:'s| is).*screen|on screen|what do you see/.test(lower)
  };
}

module.exports = {
  parseIntent,
  detectPlatform,
  parseTargets,
  expandClusterTargets,
  ENTITY_IG_CLUSTERS
};
