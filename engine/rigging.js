// Rigging math: tippet, leader, weight, indicator depth, rod choice.

// "Rule of 3": hook size / 3 ≈ tippet X. Adjusted for water clarity and flow.
export function tippetX(hookSize, clarity = 'clear', flowBand = 'normal') {
  let x = Math.round(hookSize / 3);
  if (clarity === 'stained') x -= 1;
  if (clarity === 'muddy') x -= 2;
  if (clarity === 'clear' && (flowBand === 'low' || flowBand === 'very low')) x += 1;
  if (flowBand === 'high' || flowBand === 'very high') x -= 1;
  // 7X only for the tiniest flies; it's too fragile for everyday use.
  return Math.max(0, Math.min(hookSize >= 22 ? 7 : 6, x));
}

export const xLabel = (x) => `${x}X`;

// Leader length (ft) for dry / dry-dropper fishing.
export function dryLeaderFt(clarity, flowBand) {
  if (clarity === 'clear' && (flowBand === 'low' || flowBand === 'very low')) return 12;
  if (clarity === 'clear' || clarity === 'slight') return 9;
  return 7.5;
}

// How fast the water is, 0 (slow) .. 3 (very fast), from water type + flow.
export function speedIndex(waterType, flowBand) {
  const base = { pool: 0, flat: 0, run: 1, riffle: 2, pocket: 2 }[waterType] ?? 1;
  const adj = { 'very low': -1, low: 0, normal: 0, high: 1, 'very high': 1 }[flowBand] ?? 0;
  return Math.max(0, Math.min(3, base + adj));
}

// Indicator depth: ~1.5x water depth, up to 2x in fast water so flies get down.
export function indicatorDepthFt(depthFt, speed) {
  const mult = speed >= 2 ? 2 : 1.5;
  return Math.round(depthFt * mult * 2) / 2;
}

// Split shot suggestion by speed and depth.
export function splitShot(speed, depthFt, heavy = false) {
  let units = speed + (depthFt >= 5 ? 1 : 0) + (heavy ? 1 : 0);
  if (units <= 0) return 'none (a tungsten bead fly is enough)';
  if (units === 1) return '1 small shot (#4 / BB)';
  if (units === 2) return '2 BB shot';
  if (units === 3) return '1 AB + 1 BB shot';
  return '2 AB shot (add more until you tick bottom)';
}

// Tungsten bead size for euro nymphing.
export function euroBeadMm(speed, depthFt) {
  const v = speed + (depthFt >= 4 ? 1 : 0);
  return ['2.5 mm', '2.8 mm', '3.3 mm', '3.8 mm', '4.0 mm'][Math.min(4, v)];
}

// Pick the best rod from the gear list. want = { wt, types: ['single'] }.
export function pickRod(gear, want) {
  const ideal = `${want.len || 9}ft ${want.wt}wt${want.types[0] !== 'single' ? ' ' + want.types[0] : ''}`;
  const rods = (gear && gear.rods) || [];
  if (!rods.length) return { text: ideal, note: null, owned: null };
  const scored = rods.map((r) => {
    let s = Math.abs(r.wt - want.wt) * 2;
    if (!want.types.includes(r.type)) s += 3;
    return { r, s };
  }).sort((a, b) => a.s - b.s);
  const best = scored[0];
  const r = best.r;
  const label = `your ${r.len}ft ${r.wt}wt${r.type !== 'single' ? ' ' + r.type : ''}`;
  if (best.s === 0) return { text: label, note: null, owned: r };
  if (best.s <= 2) return { text: label, note: `Ideal is a ${ideal}. Yours will do the job.`, owned: r };
  return { text: label, note: `Ideal is a ${ideal}. Your closest is ${label.replace('your ', '')}, which isn't a great match.`, owned: r, poor: true };
}

export function hasRodType(gear, type) {
  return !!(gear && gear.rods && gear.rods.some((r) => r.type === type));
}

// Parse hook size from a fly string like "Pheasant Tail #16-18" -> 17.
export function hookSizeOf(fly, fallback = 14) {
  const m = /#(\d+)(?:-(\d+))?/.exec(fly || '');
  if (!m) return fallback;
  const a = +m[1], b = m[2] ? +m[2] : a;
  return Math.round((a + b) / 2);
}
