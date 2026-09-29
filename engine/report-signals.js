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
