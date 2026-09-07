/**
 * build-artifact-data.mjs — the missing regions.json -> curl-builder handoff.
 *
 *   node build-artifact-data.mjs
 *
 * Reads regions.json (scraper output) and emits artifact-models.json: a single,
 * normalised, builder-shaped payload that the Vertex Curl Builder can be synced
 * from. This is the step that previously did not exist — the scraper committed
 * regions.json and stopped, leaving the builder's model list and its
 * REGIONS_UPDATED / REGIONS_SOURCE stamps to be maintained by hand.
 *
 * Policy encoded here:
 *   - preview / experimental models are marked preview:true and excluded from
 *     `models` (they are listed under `excluded` so nothing disappears silently)
 *   - `status` from the scraper is carried through untouched, so the consumer can
 *     decide what to do with status:"new" (this script never promotes anything)
 *   - capabilities use the scraper's `inferred` block when present, else are
 *     derived from the model id; `capabilitySource` records which was used
 *   - failures[] are propagated so a downstream consumer can alert on them
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

if (!existsSync('regions.json')) {
  console.error('::error::regions.json not found — run scrape.mjs first.');
  process.exit(1);
}
const src = JSON.parse(readFileSync('regions.json', 'utf8'));

const PREVIEW_RE = /(^|[-_.])(preview|exp|experimental)([-_.]|$)/i;

/** gemini-3.8-flash -> "Gemini 3.8 Flash"; veo-3.1-fast-generate-001 -> "Veo 3.1 Fast Generate 001" */
function displayName(id) {
  return id.split('-').map(part => {
    if (/^\d/.test(part)) return part;                    // 3.8, 001, 2
    if (part === 'gemini' || part === 'veo') return part[0].toUpperCase() + part.slice(1);
    if (part === 'lite') return 'Lite';
    return part[0].toUpperCase() + part.slice(1);
  }).join(' ');
}

/** Fallback when the scraper produced no `inferred` block. */
function deriveCapability(id) {
  if (/embedding/i.test(id))
    return { modelType: 'EMBEDDING',
             capabilities: [{ inputModalities: ['TEXT'], outputModalities: ['EMBEDDINGS'] }] };
  if (/^veo|virtual-try-on/i.test(id))
    return { modelType: 'VIDEO_GENERATION',
             capabilities: [{ inputModalities: ['TEXT', 'IMAGE'], outputModalities: ['VIDEO'] }] };
  if (/image/i.test(id))
    return { modelType: 'IMAGE_GENERATION',
             capabilities: [{ inputModalities: ['TEXT', 'IMAGE'], outputModalities: ['IMAGE'] }] };
  return { modelType: 'TEXT_GENERATION',
           capabilities: [{ inputModalities: ['TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'FILE'],
                            outputModalities: ['TEXT'] }] };
}

const models = [], excluded = [];

for (const [id, e] of Object.entries(src.models || {})) {
  const preview = PREVIEW_RE.test(id);
  const cap = e.inferred || deriveCapability(id);
  const row = {
    id,
    name: displayName(id),
    modelType: cap.modelType,
    capabilities: cap.capabilities,
    capabilitySource: e.inferred ? 'scraped' : 'derived',
    regions: [...(e.regions || [])].sort(),
    status: e.status || 'known',
    url: e.url || null,
  };
  if (e.deprecationNote) row.deprecationNote = e.deprecationNote;
  if (preview) { excluded.push({ ...row, reason: 'preview or experimental — never exposed' }); }
  else { models.push(row); }
}

models.sort((a, b) => a.id.localeCompare(b.id));

const out = {
  generatedAt: new Date().toISOString(),
  provenance: {
    // These two are what the builder's REGIONS_UPDATED / REGIONS_SOURCE must be set from.
    regionsUpdated: (src.fetchedAt || '').slice(0, 10),
    regionsSource: src.source || null,
    fetchedAt: src.fetchedAt || null,
  },
  counts: {
    exposed: models.length,
    excludedPreview: excluded.length,
    statusNew: models.filter(m => m.status === 'new').length,
    failures: (src.failures || []).length,
  },
  models,
  excluded,
  failures: src.failures || [],
};

writeFileSync('artifact-models.json', JSON.stringify(out, null, 2) + '\n');

console.log(`artifact-models.json: ${out.counts.exposed} exposed, ` +
            `${out.counts.excludedPreview} preview excluded, ` +
            `${out.counts.statusNew} awaiting promotion, ` +
            `${out.counts.failures} scrape failures`);
if (out.counts.statusNew)
  console.log('Awaiting promotion into models.json: ' +
    models.filter(m => m.status === 'new').map(m => m.id).join(', '));
