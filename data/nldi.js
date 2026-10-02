// Where you are on the river network relative to a gauge, from the free USGS NLDI service
// (NHDPlus stream segments). No API key.
import { distanceMi } from './usgs.js';

const NLDI = 'https://api.water.usgs.gov/nldi/linked-data';
const SEARCH_KM = 80; // how far up/downstream of the gauge to look

async function getJSON(url, ms = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// The stream segment nearest you: snap to the closest flowline (best when you're on the bank),
// falling back to the catchment you're standing in.
const comidAt = async (lat, lon) => {
  const pt = encodeURIComponent(`POINT(${lon.toFixed(5)} ${lat.toFixed(5)})`);
  try {
    const j = await getJSON(`${NLDI}/hydrolocation?f=json&coords=${pt}`);
    const f = (j.features || []).find((x) => x.properties && x.properties.comid);
    if (f) return String(f.properties.comid);
  } catch (e) { /* fall through */ }
  const j = await getJSON(`${NLDI}/comid/position?f=json&coords=${pt}`);
  return String(j.features[0].properties.comid);
};
const gaugeComid = async (id) => String((await getJSON(`${NLDI}/nwissite/USGS-${id}?f=json`)).features[0].properties.comid);
const reach = async (comid, dir) => {
  const j = await getJSON(`${NLDI}/comid/${comid}/navigation/${dir}/flowlines?f=json&distance=${SEARCH_KM}`, 30000);
  return (j.features || []).map((f) => String(f.properties.nhdplus_comid));
};

// -> { relation: 'at' | 'upstream' | 'downstream' | 'other-stream', miles }
// 'upstream' = you're upstream of the gauge on the same river (main stem).
export async function locate(lat, lon, site) {
  const miles = Math.round(distanceMi(lat, lon, site.lat, site.lon) * 10) / 10;
  const [you, gauge] = await Promise.all([comidAt(lat, lon), gaugeComid(site.id)]);
  if (you === gauge || miles < 1) return { relation: 'at', miles };
  const [up, down] = await Promise.all([reach(gauge, 'UM'), reach(gauge, 'DM')]);
  if (up.includes(you)) return { relation: 'upstream', miles };
  if (down.includes(you)) return { relation: 'downstream', miles };
  return { relation: 'other-stream', miles };
}
