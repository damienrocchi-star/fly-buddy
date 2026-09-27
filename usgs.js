// USGS river gauges: free, no API key.
// Area/name lookups use the new USGS Water Data API (fast). Single-gauge detail and
// flow history use the legacy NWIS services (fast for one site). Each falls back to the other.
const IV = 'https://waterservices.usgs.gov/nwis/iv/';
const STAT = 'https://waterservices.usgs.gov/nwis/stat/';
const API = 'https://api.waterdata.usgs.gov/ogcapi/v0/collections';
const LATEST = `${API}/latest-continuous/items`;
const CONTINUOUS = `${API}/continuous/items`;
const LOCATIONS = `${API}/monitoring-locations/items`;
const MAX_AGE_MS = 48 * 3600e3; // ignore gauges that haven't reported in 2 days

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
  return n.replace(/\b(Nr|nr|Near)\b/g, 'near').replace(/\b(At|Below|Above|Bl|Ab)\b/g, (w) => w.toLowerCase())
    .replace(/\b([A-Z][a-z])$/, (m) => m.toUpperCase());
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

const idOf = (f) => (f.properties.monitoring_location_id || f.id).replace(/^USGS-/, '');

// Stream gauge names for everything in a box: { id: "Pere Marquette River at Scottville, MI" }.
async function namesInBbox(bbox) {
  const json = await getJSON(`${LOCATIONS}?f=json&bbox=${bbox}&site_type_code=ST&limit=3000&properties=monitoring_location_name&skipGeometry=true`, 25000);
  const out = {};
  for (const f of json.features || []) out[f.id.replace(/^USGS-/, '')] = tidyName(f.properties.monitoring_location_name || '');
  return out;
}

async function namesForIds(ids) {
  const list = ids.map((id) => `'USGS-${id}'`).join(',');
  const json = await getJSON(`${LOCATIONS}?f=json&filter-lang=cql2-text&filter=${encodeURIComponent(`id IN (${list})`)}&properties=monitoring_location_name&skipGeometry=true&limit=${ids.length}`);
  const out = {};
  for (const f of json.features || []) out[f.id.replace(/^USGS-/, '')] = tidyName(f.properties.monitoring_location_name || '');
  return out;
}

// Latest readings (new API) -> site list. Drops stale sensors; names come from `names`.
function parseLatest(json, names) {
  const sites = {};
  const now = Date.now();
  for (const f of json.features || []) {
    const p = f.properties;
    const v = parseFloat(p.value);
    if (isNaN(v) || now - new Date(p.time).getTime() > MAX_AGE_MS) continue;
    const id = idOf(f);
    if (names && !names[id]) continue; // not a stream gauge (well, lake, etc.)
    const s = sites[id] || (sites[id] = { id, name: (names && names[id]) || `USGS gauge ${id}`, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] });
    const key = p.parameter_code === P_FLOW ? 'flowSeries' : p.parameter_code === P_TEMP ? 'tempSeries' : null;
    // A site can have several sensors; keep the newest reading.
    if (key && (!s[key] || s[key][0].t < p.time)) s[key] = [{ t: p.time, v }];
  }
  const list = Object.values(sites);
  list.forEach(summarize);
  return list;
}

const bboxAround = (lat, lon, d) => [lon - d * 1.3, lat - d, lon + d * 1.3, lat + d].map((x) => x.toFixed(4)).join(',');

// Gauges near a point, closest first. Widens the search if nothing is close.
export async function findNearby(lat, lon) {
  for (const d of [0.35, 0.8, 1.6]) {
    const bbox = bboxAround(lat, lon, d);
    let list;
    try {
      const [latest, names] = await Promise.all([
        getJSON(`${LATEST}?f=json&bbox=${bbox}&parameter_code=${P_FLOW},${P_TEMP}&limit=3000`, 25000),
        namesInBbox(bbox).catch(() => null),
      ]);
      list = parseLatest(latest, names);
    } catch (e) {
      // Legacy service: slower, but has names built in.
      const url = `${IV}?format=json&bBox=${bbox}&parameterCd=${P_FLOW},${P_TEMP}&siteType=ST&siteStatus=active&period=PT3H`;
      list = parseIV(await getJSON(url, 60000));
    }
    list = list.filter((s) => s.cfs != null || s.waterTempF != null);
    if (list.length >= 3 || d === 1.6) {
      for (const s of list) s.dist = distanceMi(lat, lon, s.lat, s.lon);
      return list.sort((a, b) => a.dist - b.dist).slice(0, 15);
    }
  }
  return [];
}

const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
const SKIP_WORDS = new Set(['RIVER', 'R', 'THE', 'AT', 'NEAR', 'NR', 'OF']);
const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };

// Search by river or place name, anywhere in the US. Returns only gauges reporting live data.
// 1) Match gauge names ("pere marquette", "madison mt").  2) If none, treat it as a town and list gauges nearby.
export async function searchByName(query) {
  const raw = query.toUpperCase().replace(/[^A-Z0-9 ,]/g, ' ');
  let words = raw.replace(/,/g, ' ').split(/\s+/).filter((w) => w && !SKIP_WORDS.has(w));
  // A trailing state code ("... MT") narrows the search to that state.
  let state = null;
  if (words.length > 1 && STATES[words[words.length - 1]]) state = words.pop();
  if (words.length) {
    // Gauge names are stored in mixed case ("PERE MARQUETTE", "Madison River"), so match case-insensitively.
    const conds = ["site_type_code='ST'", ...words.map((w) => `CASEI(monitoring_location_name) LIKE CASEI('%${w.replace(/'/g, '')}%')`)];
    if (state) conds.push(`state_name='${STATES[state]}'`);
    const url = `${LOCATIONS}?f=json&limit=500&properties=monitoring_location_name,state_name&filter=${encodeURIComponent(conds.join(' AND '))}&filter-lang=cql2-text`;
    const json = await getJSON(url, 30000);
    const names = {};
    for (const f of json.features || []) names[f.id.replace(/^USGS-/, '')] = tidyName(f.properties.monitoring_location_name || '');
    const live = await liveSites(names);
    if (live.length) return { kind: 'name', sites: live.sort((a, b) => a.name.localeCompare(b.name)) };
  }
  // Fall back to a place name.
  const place = await geocode(query);
  if (!place) return { kind: 'none', sites: [] };
  const sites = await findNearby(place.lat, place.lon);
  return { kind: 'place', place: place.label, sites };
}

// Which of these gauges are reporting right now (with their latest readings). names = { id: name }.
async function liveSites(names) {
  const ids = Object.keys(names);
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    try {
      const filter = `monitoring_location_id IN (${batch.map((id) => `'USGS-${id}'`).join(',')})`;
      const json = await getJSON(`${LATEST}?f=json&parameter_code=${P_FLOW},${P_TEMP}&filter-lang=cql2-text&filter=${encodeURIComponent(filter)}&limit=1000`, 25000);
      out.push(...parseLatest(json, names).filter((s) => s.cfs != null || s.waterTempF != null));
    } catch (e) {
      try {
        const json = await getJSON(`${IV}?format=json&sites=${batch.join(',')}&parameterCd=${P_FLOW},${P_TEMP}&siteStatus=active&period=PT3H`, 45000);
        out.push(...parseIV(json).filter((s) => s.cfs != null || s.waterTempF != null));
      } catch (e2) { /* no live sites in this batch */ }
    }
  }
  return out;
}

async function geocode(query) {
  const parts = query.split(',').map((s) => s.trim()).filter(Boolean);
  let name = parts[0], st = parts[1] ? parts[1].toUpperCase() : null;
  const m = /^(.*\S)\s+([A-Za-z]{2})$/.exec(name);
  if (!st && m && STATES[m[2].toUpperCase()]) { name = m[1]; st = m[2].toUpperCase(); }
  const json = await getJSON(`${GEOCODE}?name=${encodeURIComponent(name)}&count=10&countryCode=US&language=en&format=json`);
  let res = json.results || [];
  if (st) res = res.filter((r) => r.admin1 === (STATES[st] || st) || (r.admin1 || '').toUpperCase() === st);
  const r = res[0];
  return r ? { lat: r.latitude, lon: r.longitude, label: `${r.name}, ${r.admin1}` } : null;
}

// Full detail for one gauge (last 24h, for trend).
export async function getSite(id) {
  try {
    const url = `${IV}?format=json&sites=${id}&parameterCd=${P_FLOW},${P_TEMP},${P_HEIGHT}&period=P1D`;
    const list = parseIV(await getJSON(url, 15000));
    if (list.length) return list[0];
  } catch (e) { /* fall through to the new API */ }
  const series = (code) => getJSON(`${CONTINUOUS}?f=json&monitoring_location_id=USGS-${id}&parameter_code=${code}&time=P1D&limit=500&properties=time,value`, 25000)
    .then((j) => (j.features || []).map((f) => ({ t: f.properties.time, v: parseFloat(f.properties.value) })).filter((p) => !isNaN(p.v)).sort((a, b) => (a.t < b.t ? -1 : 1)))
    .catch(() => []);
  const [flow, temp, names, loc] = await Promise.all([
    series(P_FLOW), series(P_TEMP), namesForIds([id]).catch(() => ({})),
    getJSON(`${LOCATIONS}/USGS-${id}?f=json`).catch(() => null),
  ]);
  if (!flow.length && !temp.length) throw new Error('No data for this gauge');
  const s = { id, name: names[id] || `USGS gauge ${id}`, flowSeries: flow, tempSeries: temp };
  if (loc && loc.geometry) { s.lon = loc.geometry.coordinates[0]; s.lat = loc.geometry.coordinates[1]; }
  summarize(s);
  return s;
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
