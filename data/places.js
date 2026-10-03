// Look up a typed place ("Gleasons Landing", "Walhalla") near a gauge with the free OpenStreetMap
// search (Nominatim). No API key. Only the text you type is sent. Their fair-use limit is one
// request a second, so the second attempt waits.
import { distanceMi } from './usgs.js';

const URL_ = 'https://nominatim.openstreetmap.org/search';
const MAX_MI = 60;
const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska',
  NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
  UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };

async function search(q, lat, lon) {
  const d = 0.9;
  const box = [lon - d * 1.3, lat + d, lon + d * 1.3, lat - d].map((x) => x.toFixed(3)).join(',');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(`${URL_}?format=jsonv2&limit=8&countrycodes=us&viewbox=${box}&q=${encodeURIComponent(q)}`, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// -> up to 3 matches within 60 mi of the gauge, nearest first: [{ name, detail, lat, lon, miles }]
export async function findPlace(text, lat, lon, state) {
  const near = (rows) => rows.map((x) => {
    const parts = String(x.display_name || '').split(',').map((s) => s.trim());
    return { name: x.name || parts[0], detail: parts.slice(1, 3).join(', '), lat: +x.lat, lon: +x.lon, miles: distanceMi(lat, lon, +x.lat, +x.lon) };
  }).filter((m) => m.miles <= MAX_MI).sort((a, b) => a.miles - b.miles).slice(0, 3);
  let out = near(await search(text, lat, lon));
  if (!out.length && STATES[state]) {
    await new Promise((r) => setTimeout(r, 1100));
    out = near(await search(`${text}, ${STATES[state]}`, lat, lon));
  }
  return out;
}
