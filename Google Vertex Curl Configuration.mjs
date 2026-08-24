/**
 * Builds regions.json — the source of truth for the Vertex Curl Builder.
 *
 *   node scrape.mjs            normal run
 *   node scrape.mjs --debug    dump page text for anything that failed
 *
 * For every known model it reads regions, capabilities and any deprecation
 * note. It also crawls the index page and reports models it has never seen.
 *
 * Safety rules:
 *   - a model whose page can't be read KEEPS its previous data
 *   - only region codes on a hardcoded allowlist are accepted
 *   - discovered models are marked  status:"new"  and never auto-enabled
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const DEBUG = process.argv.includes('--debug');
const cfg = JSON.parse(readFileSync('models.json', 'utf8'));
const prev = existsSync('regions.json')
  ? JSON.parse(readFileSync('regions.json', 'utf8'))
  : { models: {} };

const VOCAB = new Set([
  'global',
  'us-west1','us-west4','us-central1','us-east1','us-east4','us-east5','us-south1',
  'northamerica-northeast1','northamerica-northeast2','southamerica-east1','southamerica-west1',
  'europe-west1','europe-west2','europe-west3','europe-west4','europe-west6','europe-west8',
  'europe-west9','europe-west12','europe-north1','europe-central2','europe-southwest1',
  'asia-south1','asia-south2','asia-southeast1','asia-southeast2','asia-east1','asia-east2',
  'asia-northeast1','asia-northeast2','asia-northeast3','australia-southeast1','australia-southeast2',
  'me-west1','me-central1','me-central2','africa-south1',
]);

/* ---------- extraction helpers (run against plain page text) ---------- */

function regionsFrom(text) {
  const i = text.search(/Supported\s+regions/i);
  if (i === -1) return null;
  let b = text.slice(i, i + 4000);
  const stop = b.search(/\n\s*(Quotas|Pricing|Technical specifications|Model versions|Supported inputs|Try in)/i);
  if (stop > 200) b = b.slice(0, stop);
  const found = new Set();
  for (const m of b.matchAll(/[a-z]+-[a-z0-9-]+\d|global/gi)) {
    const t = m[0].toLowerCase();
    if (VOCAB.has(t)) found.add(t);
  }
  return found.size ? [...found].sort() : null;
}

/* Google phrases deprecation several ways; catch the sentence, don't judge it. */
function deprecationFrom(text) {
  const m = text.match(/[^.\n]*\b(deprecat\w*|retire\w*|shut ?down|discontinu\w*|no longer available)\b[^.\n]*\./i);
  return m ? m[0].trim().replace(/\s+/g, ' ').slice(0, 300) : null;
}

const MODALITY = { text:'TEXT', image:'IMAGE', video:'VIDEO', audio:'AUDIO',
                   pdf:'FILE', document:'FILE', file:'FILE', code:'TEXT',
                   embedding:'EMBEDDINGS', embeddings:'EMBEDDINGS' };

function capabilitiesFrom(text) {
  const grab = (label) => {
    const re = new RegExp(label + '\\s*[:\\n]([\\s\\S]{0,220})', 'i');
    const m = text.match(re);
    if (!m) return null;
    const seg = m[1].split(/\n\s*\n/)[0];
    const out = new Set();
    for (const [word, code] of Object.entries(MODALITY))
      if (new RegExp('\\b' + word + '\\b', 'i').test(seg)) out.add(code);
    return out.size ? [...out] : null;
  };
  const inputs  = grab('Supported inputs') || grab('Inputs');
  const outputs = grab('Supported outputs') || grab('Outputs');
  if (!inputs && !outputs) return null;
  const o = outputs || ['TEXT'];
  const modelType =
    o.includes('EMBEDDINGS') ? 'EMBEDDING' :
    o.includes('VIDEO')      ? 'VIDEO_GENERATION' :
    o.includes('IMAGE')      ? 'IMAGE_GENERATION' : 'TEXT_GENERATION';
  return { modelType, capabilities: [{ inputModalities: inputs || ['TEXT'], outputModalities: o }] };
}

function modelIdFrom(text) {
  const m = text.match(/\b(gemini|veo|imagen|text-embedding|text-multilingual-embedding)[a-z0-9.\-]*\b/i);
  return m ? m[0].toLowerCase() : null;
}

/* ---------- browser ---------- */

const browser = await chromium.launch();
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
});
const page = await ctx.newPage();

/** Text of the whole page, or just one anchored section when `anchor` is given. */
async function pageText(url, anchor) {
  const res = await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  if (!res || res.status() >= 400) throw new Error(`HTTP ${res ? res.status() : '?'}`);
  await page.waitForTimeout(1200);
  if (!anchor) return page.evaluate(() => document.body.innerText);
  const scoped = await page.evaluate((id) => {
    const el = document.getElementById(id) ||
               document.querySelector(`[id="${CSS.escape(id)}"]`);
    if (!el) return null;
    const head = el.closest('h1,h2,h3,h4') || el;
    const level = +(head.tagName[1] || 2);
    let out = head.innerText + '\n';
    for (let n = head.nextElementSibling; n; n = n.nextElementSibling) {
      if (/^H[1-6]$/.test(n.tagName) && +n.tagName[1] <= level) break;
      out += n.innerText + '\n';
    }
    return out;
  }, anchor);
  if (!scoped) throw new Error(`anchor #${anchor} not found on page`);
  return scoped;
}

const out = {
  fetchedAt: new Date().toISOString(),
  source: cfg._baseUrl,
  models: {},
};
const failures = [], notes = [];

/* ---------- 1. known models ---------- */
for (const [model, spec] of Object.entries(cfg.models)) {
  const url = cfg._baseUrl + spec.path + (spec.anchor ? '#' + spec.anchor : '');
  try {
    const text = await pageText(cfg._baseUrl + spec.path, spec.anchor);
    const regions = regionsFrom(text);
    if (!regions) throw new Error('no "Supported regions" block');
    const entry = { regions, url, status: prev.models?.[model]?.status || 'known' };
    const caps = capabilitiesFrom(text);
    if (caps) entry.inferred = caps;
    const dep = deprecationFrom(text);
    if (dep) { entry.deprecationNote = dep; notes.push(`${model}: ${dep}`); }
    out.models[model] = entry;
    console.log(`OK    ${model.padEnd(32)} ${regions.length} regions${dep ? '  ** DEPRECATION NOTE **' : ''}`);
  } catch (err) {
    failures.push({ model, url, error: String(err.message || err) });
    if (prev.models?.[model]) out.models[model] = prev.models[model];
    console.log(`FAIL  ${model.padEnd(32)} ${err.message || err}${prev.models?.[model] ? '  (kept previous)' : ''}`);
    if (DEBUG) {
      try { console.log('-----\n' + (await page.evaluate(() => document.body.innerText)).slice(0, 1500) + '\n-----'); } catch {}
    }
  }
}

/* ---------- 2. discovery ---------- */
const discovered = [];
try {
  await page.goto(cfg._indexUrl, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(1500);
  const links = await page.evaluate((base) =>
    [...document.querySelectorAll('a[href]')]
      .map(a => a.href.split('#')[0].split('?')[0])
      .filter(h => h.startsWith(base) && h !== base && !h.endsWith('/google-models')),
    cfg._baseUrl);

  const knownPaths = new Set(Object.values(cfg.models).map(s => cfg._baseUrl + s.path));
  const fresh = [...new Set(links)].filter(u => !knownPaths.has(u));

  for (const url of fresh) {
    try {
      const text = await pageText(url);
      const regions = regionsFrom(text);
      const id = modelIdFrom(text);
      if (!id || !regions) { console.log(`skip  ${url}  (not a model page)`); continue; }
      if (out.models[id]) continue;
      const entry = { regions, url, status: 'new' };
      const caps = capabilitiesFrom(text);
      if (caps) entry.inferred = caps;
      const dep = deprecationFrom(text);
      if (dep) entry.deprecationNote = dep;
      out.models[id] = entry;
      discovered.push(id);
      console.log(`NEW   ${id.padEnd(32)} ${regions.length} regions  ${dep ? '(deprecated)' : ''}`);
    } catch { /* index links to plenty of non-model pages; ignore quietly */ }
  }
} catch (err) {
  failures.push({ model: '(index page)', url: cfg._indexUrl, error: String(err.message || err) });
  console.log(`FAIL  index page  ${err.message || err}`);
}

await browser.close();

if (failures.length) out.failures = failures;
if (discovered.length) out.discovered = discovered;
writeFileSync('regions.json', JSON.stringify(out, null, 2) + '\n');

/* ---------- 3. changelog ---------- */
const changes = [];
for (const [m, e] of Object.entries(out.models)) {
  const b = prev.models?.[m];
  if (!b) { changes.push(`NEW MODEL ${m} (${e.regions.length} regions)`); continue; }
  const added = e.regions.filter(r => !b.regions.includes(r));
  const gone  = b.regions.filter(r => !e.regions.includes(r));
  if (added.length || gone.length)
    changes.push(`${m}${added.length ? ' +[' + added.join(',') + ']' : ''}${gone.length ? ' -[' + gone.join(',') + ']' : ''}`);
  if (e.deprecationNote && !b.deprecationNote) changes.push(`DEPRECATED ${m}: ${e.deprecationNote}`);
}
for (const m of Object.keys(prev.models || {})) if (!out.models[m]) changes.push(`GONE ${m} (page no longer listed)`);

console.log(`\n${Object.keys(out.models).length} models, ${failures.length} failed, ${discovered.length} newly discovered`);
if (notes.length) console.log('\nDEPRECATION NOTES:\n' + notes.join('\n'));
console.log(changes.length ? '\nCHANGES:\n' + changes.join('\n') : '\nNo changes since last run.');
writeFileSync('changes.txt', changes.join('\n'));

if (Object.keys(out.models).length === 0) process.exit(1);
