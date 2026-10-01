// Display units. Everything is stored in US units (°F, cfs, ft, mph, in); this converts for showing.
//   us       °F, cfs, ft, mph, in
//   metric   °C, m³/s (cumecs), m, km/h, mm / cm
//   captured each number in the unit its source recorded it in (USGS water temp °C, USGS flow cfs,
//            weather °C and km/h, your thermometer as you typed it). App-made text uses US units.
export const UNIT_MODES = [['us', 'US'], ['metric', 'Metric'], ['captured', 'As captured']];
let mode = 'us';

export function setUnitMode(m) { mode = UNIT_MODES.some(([k]) => k === m) ? m : 'us'; }
export function unitMode() { return mode; }

const num = (v, dp = 0) => {
  const k = 10 ** dp;
  return (Math.round(v * k) / k).toLocaleString(undefined, { maximumFractionDigits: dp });
};
// Which system to use for one value: in "captured" mode, the source's own ('us' or 'metric').
const sys = (cap) => (mode === 'captured' ? (cap || 'us') : mode);

export const fToC = (f) => ((f - 32) * 5) / 9;
export const cToF = (c) => (c * 9) / 5 + 32;

// kind: temp (°F in) · flow (cfs) · len (ft) · wind (mph) · rain (in) · fish (in)
export function fmt(kind, v, cap) {
  if (v == null || v === '' || isNaN(v)) return '—';
  const metric = sys(cap) === 'metric';
  switch (kind) {
    case 'temp': return metric ? `${num(fToC(v))}°C` : `${num(v)}°F`;
    case 'flow': {
      if (!metric) return `${num(v)} cfs`;
      const m3 = v * 0.0283168;
      return `${num(m3, m3 < 10 ? 2 : m3 < 100 ? 1 : 0)} m³/s`;
    }
    case 'len': return metric ? `${num(v * 0.3048, 1)} m` : `${num(v, 1)} ft`;
    case 'wind': return metric ? `${num(v * 1.609)} km/h` : `${num(v)} mph`;
    case 'rain': return metric ? `${num(v * 25.4, 1)} mm` : `${num(v, 2)} in`;
    case 'fish': return metric ? `${num(v * 2.54)} cm` : `${num(v, 1)}"`;
    default: return String(v);
  }
}

// Number only (for inputs and sliders) and the unit label.
export function val(kind, v, cap) {
  const metric = sys(cap) === 'metric';
  if (v == null || v === '') return '';
  if (kind === 'temp') return Math.round(metric ? fToC(v) : v);
  if (kind === 'len') return metric ? Math.round(v * 0.3048 * 10) / 10 : v;
  if (kind === 'fish') return metric ? Math.round(v * 2.54) : v;
  return v;
}
export function unitOf(kind, cap) {
  const metric = sys(cap) === 'metric';
  return { temp: metric ? '°C' : '°F', len: metric ? 'm' : 'ft', fish: metric ? 'cm' : 'in', flow: metric ? 'm³/s' : 'cfs' }[kind];
}
// A typed value in the units on screen -> stored US value.
export function fromInput(kind, v) {
  if (v === '' || v == null || isNaN(+v)) return v;
  const metric = mode === 'metric';
  if (kind === 'temp') return metric ? Math.round(cToF(+v)) : +v;
  if (kind === 'fish') return metric ? Math.round((+v / 2.54) * 10) / 10 : +v;
  return +v;
}

// Convert numbers inside engine-written text ("9 ft leader", "Water is 70°F", "18 in of 5X") to metric.
// In US and "as captured" modes the text is left as written.
export function localize(text) {
  if (mode !== 'metric' || !text) return text;
  return String(text)
    .replace(/(-?\d+(?:\.\d+)?)\s?°F/g, (_, n) => `${num(fToC(+n))}°C`)
    // Rod lengths ("9ft 5wt") stay in feet: rods are sold that way everywhere.
    .replace(/(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?\s?ft\b(?!\s?\d+\s?wt)/g, (_, a, b) => (b ? `${num(a * 0.3048, 1)}-${num(b * 0.3048, 1)} m` : `${num(a * 0.3048, 1)} m`))
    .replace(/[Rr]ain \((\d+(?:\.\d+)?) in\)/g, (m, n) => m.replace(`${n} in`, `${num(n * 25.4)} mm`))
    .replace(/(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?\s?in\b(?= of| dropper| tag| above| long| apart|,|\.|$)/g, (_, a, b) => (b ? `${num(a * 2.54)}-${num(b * 2.54)} cm` : `${num(a * 2.54)} cm`))
    .replace(/(\d[\d,]*)\s?cfs\b/g, (_, n) => fmt('flow', +n.replace(/,/g, '')))
    .replace(/(\d+(?:\.\d+)?)\s?mph\b/g, (_, n) => fmt('wind', +n));
}
