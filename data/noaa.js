// NOAA National Water Prediction Service: free river forecasts, no API key.
// Only some gauges have a live forecast (mostly larger rivers, or any river during high water).
const NWPS = 'https://api.water.noaa.gov/nwps/v1/gauges';

async function getJSON(url, ms = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// Find the NOAA gauge id ("SCTM4") that matches a USGS gauge. Returns null if there isn't one.
export async function findNoaaGauge(usgsId, lat, lon) {
  const d = 0.08;
  const q = `bbox.xmin=${(lon - d).toFixed(4)}&bbox.ymin=${(lat - d).toFixed(4)}&bbox.xmax=${(lon + d).toFixed(4)}&bbox.ymax=${(lat + d).toFixed(4)}&srid=EPSG_4326`;
  const list = ((await getJSON(`${NWPS}?${q}`)).gauges || [])
    .map((g) => ({ lid: g.lid, d: (g.latitude - lat) ** 2 + (g.longitude - lon) ** 2 }))
    .sort((a, b) => a.d - b.d).slice(0, 4);
  const details = await Promise.all(list.map((g) => getJSON(`${NWPS}/${g.lid}`).catch(() => null)));
  const hit = details.find((g) => g && String(g.usgsId) === String(usgsId));
  return hit ? hit.lid : null;
}

// Forecast flow averaged per local day: { "2026-09-29": 512, ... } (cfs), or null if no forecast now.
export async function getFlowForecast(lid) {
  const j = await getJSON(`${NWPS}/${lid}/stageflow/forecast`);
  const data = j.data || [];
  if (!data.length) return null;
  // Flow is the "primary" or "secondary" series depending on the gauge; find the one in cfs or kcfs.
  const unitOf = (u) => (u || '').toLowerCase();
  const field = unitOf(j.secondaryUnits).includes('cfs') ? 'secondary' : unitOf(j.primaryUnits).includes('cfs') ? 'primary' : null;
  if (!field) return null;
  const mult = unitOf(j[`${field}Units`]).startsWith('k') ? 1000 : 1;
  const days = {};
  for (const p of data) {
    const v = p[field];
    if (v == null || v < 0) continue;
    const t = new Date(p.validTime);
    const key = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    (days[key] || (days[key] = [])).push(v * mult);
  }
  const out = {};
  for (const [k, vs] of Object.entries(days)) out[k] = Math.round(vs.reduce((a, b) => a + b, 0) / vs.length);
  return Object.keys(out).length ? out : null;
}
