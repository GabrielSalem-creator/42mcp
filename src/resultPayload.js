function isUsableMediaUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (url.startsWith('blob:')) return false;
  return url.startsWith('http');
}

function flattenItems(resultBundle) {
  const items = [];
  for (const block of resultBundle.results || []) {
    for (const p of block.posts || []) items.push({ ...p, _bucket: 'post' });
    for (const s of block.stories || []) items.push({ ...s, _bucket: 'story' });
    if (block.profileRecord) items.push({ ...block.profileRecord, _bucket: 'profile' });
  }
  return items.filter((i) => isUsableMediaUrl(i.mediaUrl) || isUsableMediaUrl(i.thumbnailUrl) || i.type === 'profile');
}

function buildPayload({ request, results, meta = {} }) {
  const flat = flattenItems({ results });
  return {
    request,
    collectedAt: new Date().toISOString(),
    summary: {
      targets: results.map((r) => r.target),
      totalPosts: results.reduce((n, r) => n + (r.postCount || 0), 0),
      totalStories: results.reduce((n, r) => n + (r.storyCount || 0), 0),
      totalItems: flat.length,
      searchQuery: meta.searchQuery || null,
      profilesDiscovered: meta.profilesDiscovered || null,
      nameFilter: meta.nameFilter || null
    },
    results,
    items: flat
  };
}

function summarizeText(payload) {
  const s = payload.summary;
  const lines = [];
  if (s.searchQuery && s.profilesDiscovered) {
    lines.push(
      `Instagram search "${s.searchQuery}": ${s.profilesDiscovered} profile(s) with "${s.nameFilter || s.searchQuery}" in the name.`
    );
  }
  const targetList = s.targets.map((t) => '@' + t).join(', ');
  lines.push(`Collected for: ${targetList || 'n/a'}`);
  if (s.targets.length > 8) {
    lines.push(`(${s.targets.length} accounts — see JSON for full list)`);
  }
  lines.push(
    `Posts: ${s.totalPosts} · Stories/highlights: ${s.totalStories} · Items in API: ${s.totalItems}`
  );
  for (const r of payload.results.slice(0, 5)) {
    if (r.error) {
      lines.push(`@${r.target}: skipped (${r.error})`);
    } else if (r.profile?.username || r.target) {
      const u = r.profile?.username || r.target;
      lines.push(`@${u}: ${r.postCount || 0} posts, ${r.storyCount || 0} story media`);
    }
  }
  if (payload.results.length > 5) {
    lines.push(`…and ${payload.results.length - 5} more accounts in Results JSON.`);
  }
  lines.push('Full data is in the Results panel below (gallery + JSON).');
  return lines.join('\n');
}

module.exports = { buildPayload, summarizeText, isUsableMediaUrl };
