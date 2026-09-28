// Fishing-conditions score out of 100. Pure rules, no network.
// Weights and curves live in knowledge/rating.json.
import { prepare, scoreHatches } from './recommend.js';

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// Linear interpolation along [[x, y], ...].
function curve(points, x) {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (x <= x1) {
      const [x0, y0] = points[i - 1];
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return points[points.length - 1][1];
}

const isHigh = (b) => b === 'high' || b === 'very high';

export function labelFor(score, rkb) {
  return rkb.labels.find((l) => score >= l.min) || rkb.labels[rkb.labels.length - 1];
}

// cond: same shape as recommend() input. kb: { hatches, rating, ... }.
export function rateConditions(cond, kb) {
  const c = prepare(cond);
  const rk = kb.rating;
  const sp = c.species === 'steelhead' ? rk.steelhead : rk.trout;
  const w = sp.weights;
  const T = c.waterTempF;
  const fb = cond.flowBand || null; // prepare() defaults it to 'normal'; the score wants to know if it's unknown
  const f = [];
  const add = (key, label, frac, note) => { if (w[key]) f.push({ key, label, pts: Math.round(clamp01(frac) * w[key]), max: w[key], note, frac: clamp01(frac) }); };

  // Water temperature
  const tf = curve(sp.temp, T);
  add('temp', 'Water temp', tf,
    `${T}°F${c.tempEstimated ? ' (estimated)' : ''}: ${tf >= 0.95 ? 'prime' : tf >= 0.7 ? 'good' : tf >= 0.4 ? (T < 50 ? 'cool, fish are slower' : 'warm, fish are stressed') : T < 50 ? 'cold, fish are sluggish' : 'too warm'}`);

  // Flow vs normal
  const ff = sp.flow[fb || 'unknown'];
  add('flow', 'Flow', ff, fb ? `${fb} for the time of year` : 'no flow history for this gauge');

  // Trend
  let tr, tn;
  if (c.flowTrend === 'rising') { tr = isHigh(fb) ? 0.2 : 0.35; tn = 'rising: fish often go off the bite as it colors up'; }
  else if (c.flowTrend === 'falling') { tr = isHigh(fb) ? 1 : 0.85; tn = isHigh(fb) ? 'dropping and clearing: prime' : 'dropping slowly'; }
  else if (c.flowTrend === 'steady') { tr = 1; tn = 'steady'; }
  else { tr = 0.8; tn = 'trend unknown'; }
  add('trend', 'Flow trend', tr, tn);

  // Clarity
  let cf = sp.clarity[c.clarity] ?? 0.8;
  const lowClear = c.clarity === 'clear' && (fb === 'low' || fb === 'very low');
  if (lowClear) cf = Math.min(cf, 0.6);
  add('clarity', 'Clarity', cf, lowClear ? 'low and clear: fish are very spooky'
    : { clear: 'clear: fish are spookier', slight: 'slight tint: ideal', stained: 'stained: fish are harder to reach', muddy: 'muddy: very tough' }[c.clarity]);

  // Weather and light
  let wf = 0.5;
  const wn = [];
  if (c.sky.has('overcast')) { wf += 0.3; wn.push('overcast'); }
  if (c.sky.has('drizzle')) { wf += 0.1; }
  if (c.lowLight && !c.sky.has('overcast')) { wf += 0.2; wn.push('low light'); }
  if (c.sky.has('sun') && c.tod === 'midday') { wf -= 0.25; wn.push('bright midday sun'); }
  const pt = c.weather && c.weather.pressureTrend;
  if (pt === 'falling') { wf += 0.2; wn.push('falling barometer'); }
  if (pt === 'rising' && c.sky.has('sun')) { wf -= 0.2; wn.push('bluebird day after a front'); }
  if (c.weather && c.weather.windMph >= 15) { wf -= 0.2; wn.push('windy'); }
  if (!c.weather) wn.push('no weather data');
  add('weather', 'Weather & light', wf, wn.length ? wn.join(', ') : 'average');

  // Hatch activity (trout only)
  if (w.hatch) {
    const hs = scoreHatches(kb.hatches.hatches, c);
    const top = hs[0];
    add('hatch', 'Hatch activity', top ? top.score / 0.9 : 0.3, top && top.score >= 0.35 ? `${top.h.name} likely` : 'little expected');
  }

  let score = f.reduce((s, x) => s + x.pts, 0);
  // Water temp drives everything: in cold or warm water, good flow and weather can't make up for it.
  if (tf < 0.6) score *= 0.55 + 0.75 * tf;
  let cap = null;
  if (T >= sp.stopTempF) { cap = `Water is ${T}°F. Too warm to fish safely.`; score = Math.min(score, 15); }
  else if (c.clarity === 'muddy' && fb === 'very high') { cap = 'Blown out: very high and muddy.'; score = Math.min(score, 25); }
  score = Math.round(score);

  const good = f.filter((x) => x.frac >= 0.85 && !(x.key === 'trend' && c.flowTrend !== 'falling')).sort((a, b) => b.max - a.max).slice(0, 2);
  const bad = f.filter((x) => x.frac < 0.5).sort((a, b) => (b.max - b.pts) - (a.max - a.pts)).slice(0, 2);
  // Lead with what matters most for this score: the positives on a good day, the problems on a poor one.
  const ordered = score >= 50 ? [...good, ...bad] : [...bad, ...good];
  const summary = cap || ordered.map((x) => x.note).slice(0, 3)
    .map((s, i) => (i === 0 ? s[0].toUpperCase() + s.slice(1) : s)).join(' · ');

  const lab = labelFor(score, rk);
  return { score, label: cap && T >= sp.stopTempF ? "Don't fish" : lab.label, level: cap ? 'bad' : lab.level, factors: f, summary, capped: !!cap };
}
