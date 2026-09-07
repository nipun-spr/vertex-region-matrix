/**
 * promote-discovered.mjs — auto-promotes newly discovered STABLE Gemini models
 * into models.json so they become properly tracked, without a human edit.
 *
 *   node promote-discovered.mjs
 *
 * Why this exists
 * ---------------
 * The scraper's safety rule is "discovered models are never auto-enabled". That
 * rule conflated two different things:
 *
 *   tracking  — pinning a model in models.json so Phase 1 fetches it by a stable
 *               path, fails loudly, and keeps previous data on error
 *   exposing  — putting it in front of users in the curl builder
 *
 * Blocking auto-EXPOSURE is correct and is still enforced (build-artifact-data.mjs
 * excludes preview/experimental, and status is carried through). Blocking auto-
 * TRACKING just meant retyping something the scraper already discovered.
 *
 * Nothing here is guessed: `path` is derived from the URL discovery actually
 * visited. Anything that does not clearly qualify is left at status:"new" for a
 * human, exactly as before.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const cfg     = JSON.parse(readFileSync('models.json', 'utf8'));
const regions = JSON.parse(readFileSync('regions.json', 'utf8'));

const BASE = cfg._baseUrl;

/**
 * Auto-promote ONLY the case we are confident about: a stable, versioned
 * Gemini model — gemini-3.8-flash, gemini-3.9-pro, gemini-4-flash-lite …
 *
 *   /^gemini-\d/  requires a version digit straight after "gemini-", which
 *                 admits gemini-3.9-* and gemini-4-* while rejecting product
 *                 lines like gemini-live-2.5-flash-native-audio
 *   PREVIEW_RE    rejects anything preview / exp / experimental
 *
 * Everything else (veo-*, imagen-*, virtual-try-on-*, live/native-audio, any
 * preview) stays status:"new" and needs a human. Widen this deliberately, never
 * by accident.
 */
const STABLE_GEMINI = /^gemini-\d/i;
const PREVIEW_RE    = /(^|[-_.])(preview|exp|experimental)([-_.]|$)/i;

const promoted = [], skipped = [];

for (const [id, e] of Object.entries(regions.models || {})) {
  if (e.status !== 'new') continue;              // only ever touches discoveries
  if (cfg.models[id]) continue;                  // already tracked

  if (!STABLE_GEMINI.test(id) || PREVIEW_RE.test(id)) {
    skipped.push({ id, reason: PREVIEW_RE.test(id) ? 'preview/experimental' : 'not a stable versioned Gemini model' });
    continue;
  }
  if (!e.url || !e.url.startsWith(BASE)) {
    skipped.push({ id, reason: `url missing or outside _baseUrl (${e.url || 'none'})` });
    continue;
  }
  if (!Array.isArray(e.regions) || e.regions.length === 0) {
    skipped.push({ id, reason: 'no regions extracted' });
    continue;
  }

  // path is OBSERVED, not guessed: strip the base URL and any #anchor.
  const path = e.url.slice(BASE.length).split('#')[0].replace(/\/+$/, '');
  if (!path) { skipped.push({ id, reason: 'empty path after stripping _baseUrl' }); continue; }

  cfg.models[id] = { path };
  // Promotion also settles the status, otherwise scrape.mjs carries "new"
  // forward for ever and the model looks perpetually unreviewed.
  e.status = 'known';
  promoted.push({ id, path });
}

if (promoted.length) {
  writeFileSync('models.json',  JSON.stringify(cfg, null, 2) + '\n');
  writeFileSync('regions.json', JSON.stringify(regions, null, 2) + '\n');
}

for (const p of promoted)
  console.log(`::notice title=Model auto-promoted::${p.id} -> models.json (path: ${p.path})`);
for (const s of skipped)
  console.log(`::notice title=Left for review::${s.id} — ${s.reason}`);

console.log(`\npromoted ${promoted.length}, left for review ${skipped.length}`);
writeFileSync('promotions.txt',
  promoted.map(p => `PROMOTED ${p.id} (${p.path})`).join('\n') +
  (promoted.length && skipped.length ? '\n' : '') +
  skipped.map(s => `REVIEW ${s.id} — ${s.reason}`).join('\n'));
