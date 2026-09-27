// USGS river gauges: free, no API key.
// Primary: legacy NWIS Instantaneous Values service. Fallback: new OGC Water Data API.
const IV = 'https://waterservices.usgs.gov/nwis/iv/';
const STAT = 'https://waterservices.usgs.gov/nwis/stat/';
const OGC = 'https://api.waterdata.usgs.gov/ogcapi/v0/collections/latest-continuous/items';

const P_FLOW = '00060', P_TEMP = '00010', P_HEIGHT = '00065';

async function getJSON(url, ms = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

export function distanceMi(lat1, lon1, lat2, lon2) {
  const R = 3958.8, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function tidyName(n) {
  // USGS names are often SHOUTY. Make them readable.
  if (n === n.toUpperCase()) n = n.toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase());
  return n.replace(/\b(Nr|Near)\b/i, 'near').replace(/\b([A-Z][a-z])$/, (m) => m.toUpperCase());
}

// Group NWIS timeSeries by site.
function parseIV(json) {
  const sites = {};
  for (const ts of json.value.timeSeries) {
    const si = ts.sourceInfo;
    const id = si.siteCode[0].value;
    const s = sites[id] || (sites[id] = {
      id, name: tidyName(si.siteName),
      lat: si.geoLocation.geogLocation.latitude, lon: si.geoLocation.geogLocation.longitude,
    });
    const code = ts.variable.variableCode[0].value;
    const nd = ts.variable.noDataValue;
    // Some sites have several sensors per parameter; keep the one with the most data.
    const pts = (ts.values || []).map((v) => v.value).sort((a, b) => b.length - a.length)[0] || [];
    const series = pts.map((p) => ({ t: p.dateTime, v: parseFloat(p.value) })).filter((p) => !isNaN(p.v) && p.v !== nd && p.v > -999);
    if (!series.length) continue;
    if (code === P_FLOW) s.flowSeries = series;
    if (code === P_TEMP) s.tempSeries = series;
    if (code === P_HEIGHT) s.heightSeries = series;
  }
  for (const s of Object.values(sites)) summarize(s);
  return Object.values(sites);
}

function summarize(s) {
  const last = (a) => (a && a.length ? a[a.length - 1] : null);
  const f = last(s.flowSeries);
  s.cfs = f ? f.v : null;
  s.time = f ? f.t : (last(s.tempSeries) || {}).t || null;
  const tC = last(s.tempSeries);
  s.waterTempF = tC ? Math.round(tC.v * 9 / 5 + 32) : null;
  const h = last(s.heightSeries);
  s.gaugeFt = h ? h.v : null;
  s.trend = trendOf(s.flowSeries);
}

// Compare latest flow with ~6 hours earlier.
function trendOf(series) {
  if (!series || series.length < 3) return null;
  const last = series[series.length - 1];
  const cutoff = new Date(last.t).getTime() - 6 * 3600e3;
  const earlier = series.find((p) => new Date(p.t).getTime() >= cutoff) || series[0];
  if (!earlier.v) return null;
  const ch = (last.v - earlier.v) / earlier.v;
  if (ch > 0.08) return 'rising';
  if (ch < -0.08) return 'falling';
  return 'steady';
}

// Gauges near a point, closest first. Widens the search if nothing is close.
export async function findNearby(lat, lon) {
  for (const d of [0.35, 0.8, 1.6]) {
    let list;
    try {
      const bbox = [lon - d * 1.3, lat - d, lon + d * 1.3, lat + d].map((x) => x.toFixed(4)).join(',');
      const url = `${IV}?format=json&bBox=${bbox}&parameterCd=${P_FLOW},${P_TEMP}&siteType=ST&siteStatus=active&period=PT3H`;
      list = parseIV(await getJSON(url));
    } catch (e) {
      list = await ogcNearby(lat, lon, d);
    }
    list = list.filter((s) => s.cfs != null || s.waterTempF != null);
    if (list.length >= 3 || d === 1.6) {
      for (const s of list) s.dist = distanceMi(lat, lon, s.lat, s.lon);
      return list.sort((a, b) => a.dist - b.dist).slice(0, 15);
    }
  }
  return [];
}

async function ogcNearby(lat, lon, d) {
  const bbox = [lon - d * 1.3, lat - d, lon + d * 1.3, lat + d].map((x) => x.toFixed(4)).join(',');
  const json = await getJSON(`${OGC}?f=json&bbox=${bbox}&parameter_code=${P_FLOW},${P_TEMP}&limit=500`);
  return parseOGC(json);
}

function parseOGC(json) {
  const sites = {};
  for (const f of json.features || []) {
    const p = f.properties;
    const id = p.monitoring_location_id.replace(/^USGS-/, '');
    const s = sites[id] || (sites[id] = { id, name: `USGS ${id}`, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] });
    const v = parseFloat(p.value);
    if (isNaN(v)) continue;
    if (p.parameter_code === P_FLOW) s.flowSeries = [{ t: p.time, v }];
    if (p.parameter_code === P_TEMP) s.tempSeries = [{ t: p.time, v }];
  }
  const list = Object.values(sites);
  list.forEach(summarize);
  return list;
}

// Full detail for one gauge (last 24h, for trend).
export async function getSite(id) {
  try {
    const url = `${IV}?format=json&sites=${id}&parameterCd=${P_FLOW},${P_TEMP},${P_HEIGHT}&period=P1D`;
    const list = parseIV(await getJSON(url));
    if (list.length) return list[0];
  } catch (e) { /* fall through */ }
  const json = await getJSON(`${OGC}?f=json&monitoring_location_id=USGS-${id}&limit=50`);
  const list = parseOGC(json);
  if (!list.length) throw new Error('No data for this gauge');
  return list[0];
}

// Daily flow percentiles for every day of the year: { "9-27": [p25, p50, p75] }.
export async function getFlowStats(id) {
  const url = `${STAT}?format=rdb&sites=${id}&statReportType=daily&statTypeCd=p25,p50,p75&parameterCd=${P_FLOW}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) return null;
    const lines = (await r.text()).split('\n').filter((l) => l && !l.startsWith('#'));
    if (lines.length < 3) return null;
    const head = lines[0].split('\t');
    const col = (n) => head.indexOf(n);
    const [im, id_, i25, i50, i75] = ['month_nu', 'day_nu', 'p25_va', 'p50_va', 'p75_va'].map(col);
    const out = {};
    for (const l of lines.slice(2)) {
      const c = l.split('\t');
      const p50 = parseFloat(c[i50]);
      if (isNaN(p50)) continue;
      const key = `${c[im]}-${c[id_]}`;
      // A site can have several sensor records; keep the one first seen.
      if (!out[key]) out[key] = [parseFloat(c[i25]), p50, parseFloat(c[i75])];
    }
    return Object.keys(out).length ? out : null;
  } catch (e) { return null; } finally { clearTimeout(t); }
}

// Label today's flow against the historical daily percentiles.
export function flowBand(cfs, stats, date = new Date()) {
  if (cfs == null || !stats) return null;
  const row = stats[`${date.getMonth() + 1}-${date.getDate()}`];
  if (!row) return null;
  const [p25, p50, p75] = row;
  const pct = Math.round((cfs / p50) * 100);
  let band;
  if (cfs < p25 * 0.7) band = 'very low';
  else if (cfs < p25) band = 'low';
  else if (cfs <= p75) band = 'normal';
  else if (cfs <= p75 * 1.6) band = 'high';
  else band = 'very high';
  return { band, pct, p25, p50, p75 };
}
