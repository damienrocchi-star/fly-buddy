// Pulls simple signals (techniques, hatches, colors, water conditions) out of the latest local
// fishing reports, so the app's own setups can lean the same way. Plain keyword rules, no AI.
// Vocabulary lives in knowledge/report-signals.json.

const NEGATORS = ['no', 'not', 'without', "haven't", 'havent', 'yet to', 'zero', 'nothing'];

const shortDate = (iso) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });

// Find which vocabulary phrases occur in the text, longest phrases first (and not negated).
function findPhrases(text, phrases) {
  let t = ` ${text.toLowerCase().replace(/[“”"’']/g, "'").replace(/[^a-z0-9' -]+/g, ' ').replace(/\s+/g, ' ')} `;
  const found = new Set();
  for (const p of [...phrases].sort((a, b) => b.length - a.length)) {
    const needle = ` ${p.toLowerCase()} `;
    let i = t.indexOf(needle);
    while (i >= 0) {
      const before = t.slice(0, i).trim().split(' ').slice(-3).join(' ');
      const negated = NEGATORS.some((n) => ` ${before} `.includes(` ${n} `));
      if (!negated) found.add(p);
      // Blank out the match so shorter phrases inside it ("egg" in "egg sucking leech") don't match again.
      t = t.slice(0, i + 1) + ' '.repeat(needle.length - 2) + t.slice(i + needle.length - 1);
      i = t.indexOf(needle, i + 1);
    }
  }
  return found;
}

// Every vocabulary phrase found in a text. The GitHub Action runs this over each full report post
// and stores only these matched words (not the shop's text) as item.terms.
export function findTerms(text, vocab) {
  const all = [
    ...vocab.techniques.flatMap((t) => t.words), ...vocab.hatches.flatMap((h) => h.words),
    ...vocab.colors, ...vocab.water.flatMap((w) => w.words),
  ];
  return [...findPhrases(text, all)];
}

// ---------- what you're seeing on the water ----------

// Fish observations -> setups they favor (weight 15: your eyes beat a shop report).
export const OBS_FISH = {
  rising: { label: 'fish rising', keys: ['dry', 'drydropper'] },
  chasing: { label: 'fish chasing', keys: ['streamer', 'salstreamer', 'swing'] },
  salmon: { label: 'salmon moving', keys: ['salstreamer', 'salegg'], run: 'salmon' },
  steelhead: { label: 'steelhead showing', keys: ['swing', 'shnymph'], run: 'steelhead' },
  nothing: { label: 'nothing happening', keys: [] },
};
// Generic bug chips -> hatch-name fragments ("mayfly" covers the mayfly hatches).
const OBS_BUGS = {
  caddis: ['caddis'], midges: ['midge'], stoneflies: ['stone', 'salmonfl', 'skwala', 'sallies'], hoppers: ['terrestrial'],
  mayflies: ['olive', 'hendrickson', 'sulphur', 'march brown', 'pale morning', 'drake', 'isonychia', 'trico', 'mahogany', 'hex'],
};
export const OBS_MAX_AGE_MS = 3 * 3600e3;

const minsAgo = (t, now) => {
  const m = Math.max(0, Math.round((now - t) / 60000));
  return m < 2 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} hr ago`;
};

// obs: { at, fish:[], bugs:[], water:[] } -> signals (same shape as extractSignals) plus flow/run hints.
export function observationSignals(obs, now = Date.now()) {
  if (!obs || now - obs.at > OBS_MAX_AGE_MS) return null;
  const credit = `You (${minsAgo(obs.at, now)})`;
  const out = { techs: {}, hatches: [], colors: [], water: [], credits: [credit], observed: true, runs: [], trend: null, rain: false };
  for (const f of obs.fish || []) {
    const o = OBS_FISH[f];
    if (!o) continue;
    for (const k of o.keys) if (!out.techs[k]) out.techs[k] = { label: o.label, credit, weight: 15 };
    if (o.run) out.runs.push(o.run);
  }
  for (const b of obs.bugs || []) {
    if (b === 'none') continue;
    for (const m of OBS_BUGS[b] || [b]) if (!out.hatches.includes(m)) out.hatches.push(m);
  }
  out.seenHatches = [...out.hatches];
  for (const w of obs.water || []) {
    if (w === 'up') { out.trend = 'rising'; out.water.push({ note: 'water coming up', credit }); }
    if (w === 'dropping') { out.trend = 'falling'; out.water.push({ note: 'water dropping', credit }); }
    if (w === 'rain') { out.rain = true; out.water.push({ note: 'rain started', credit }); }
  }
  return out;
}

// Your observations first, then report signals for anything you didn't cover.
export function mergeSignals(obs, rep) {
  if (!obs) return rep;
  if (!rep) return obs;
  return {
    ...obs,
    techs: { ...rep.techs, ...obs.techs },
    hatches: [...new Set([...obs.hatches, ...rep.hatches])],
    colors: rep.colors,
    water: [...obs.water, ...rep.water.filter((w) => !obs.water.some((o) => o.note === w.note))],
    credits: [...obs.credits, ...rep.credits],
  };
}

// items: [{ source, date, title, excerpt, terms? }] (newest first); dnr: { date, sections: [{ text }] } or null.
export function extractSignals({ items = [], dnr = null } = {}, vocab, now = new Date()) {
  if (!vocab) return null;
  const maxAge = (days) => now.getTime() - days * 864e5;
  const fresh = items.filter((it) => it.date && new Date(it.date).getTime() >= maxAge(vocab.freshDays || 7)).slice(0, 2);
  // Terms were matched (with negation checks) on the full post, so join them with full stops.
  const texts = fresh.map((it) => ({
    text: `${it.title}. ${it.excerpt || ''}. ${(it.terms || []).join('. ')}`, credit: `${it.source} (${shortDate(it.date)})`,
  }));
  if (dnr && dnr.date && new Date(dnr.date).getTime() >= maxAge(vocab.dnrFreshDays || 10)) {
    texts.push({ text: dnr.sections.map((s) => s.text).join(' '), credit: `Michigan DNR (${shortDate(dnr.date)})` });
  }
  if (!texts.length) return null;

  const out = { techs: {}, hatches: [], colors: [], water: [], credits: [] };
  for (const { text, credit } of texts) {
    let used = false;
    for (const t of vocab.techniques) {
      if (!findPhrases(text, t.words).size) continue;
      used = true;
      for (const k of t.keys) if (!out.techs[k]) out.techs[k] = { label: t.label, credit };
    }
    for (const h of vocab.hatches) {
      if (findPhrases(text, h.words).size && !out.hatches.includes(h.match)) { out.hatches.push(h.match); used = true; }
    }
    for (const c of findPhrases(text, vocab.colors)) if (!out.colors.includes(c)) { out.colors.push(c); used = true; }
    for (const w of vocab.water) {
      if (findPhrases(text, w.words).size && !out.water.some((x) => x.note === w.note)) { out.water.push({ note: w.note, credit }); used = true; }
    }
    if (used && !out.credits.includes(credit)) out.credits.push(credit);
  }
  return out.credits.length ? out : null;
}
