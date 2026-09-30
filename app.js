// Fly Buddy: screens, state and glue. No build step, no API keys.
import * as store from './store.js';
import { findNearby, searchByName, getSite, getFlowStats, flowBand, distanceMi } from './data/usgs.js';
import { getWeather, sunFor, moonPhase, codeText } from './data/weather.js';
import { recommend, regionFor, estimateWaterTempF, runInfo, monthRange, allHatches, prepare, scoreHatches } from './engine/recommend.js';
import { rateConditions } from './engine/rating.js';
import { extractSignals, observationSignals, mergeSignals, OBS_MAX_AGE_MS } from './engine/report-signals.js';
import { findNoaaGauge, getFlowForecast } from './data/noaa.js';

const APP_VERSION = '10'; // keep in step with CACHE in sw.js
const $app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DEFAULT_INPUTS = {
  species: 'trout', clarity: 'clear', waterType: 'run', depthFt: 3, tempOverride: '',
  // manual mode only
  flowBand: 'normal', trend: 'steady', sky: 'cloudy', wind: 'breezy', pressure: 'steady',
};

const S = {
  tab: 'water', picking: false, kb: null, favScores: {}, noaaFc: null,
  profiles: {}, riverNotes: {}, reports: null, profileOpen: false,
  openState: {}, hadSession: false, nudgeDismissed: false, observed: {}, gear: { rods: [], flies: [] }, catches: [], favorites: [], boxPhotos: [],
  inputs: { ...DEFAULT_INPUTS }, manual: false,
  site: null, wx: null, stats: null, flow: null, offline: false, loading: '',
  nearby: null, gps: null, logDraft: null, prep: '',
};

// ---------- helpers ----------

function ago(ts) {
  if (!ts) return '';
  const m = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (m < 2) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} hr ago`;
  return `${Math.round(h / 24)} days ago`;
}
const fmtTime = (d) => d ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—';
const trendArrow = (t) => ({ rising: '↑ rising', falling: '↓ falling', steady: '→ steady' }[t] || '');

// Brief message at the bottom; optional action button, e.g. { label: 'Add details', fn }.
function toast(msg, action) {
  document.querySelectorAll('.toast').forEach((x) => x.remove());
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-action'; b.textContent = action.label;
    b.addEventListener('click', () => { t.remove(); action.fn(); });
    t.appendChild(b);
  }
  document.body.appendChild(t);
  setTimeout(() => t.remove(), action ? 6000 : 2600);
}

function chips(field, options, current) {
  return `<div class="chips">${options.map(([v, l]) =>
    `<button class="chip ${String(current) === String(v) ? 'on' : ''}" data-act="set" data-f="${field}" data-v="${esc(v)}">${esc(l)}</button>`).join('')}</div>`;
}

async function saveSession() {
  await store.set('session', { inputs: S.inputs, manual: S.manual, site: S.site && { id: S.site.id, name: S.site.name, lat: S.site.lat, lon: S.site.lon } });
}

function gps() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('No GPS on this device'));
    navigator.geolocation.getCurrentPosition(
      (p) => res({ lat: p.coords.latitude, lon: p.coords.longitude }),
      (e) => rej(new Error(e.code === 1 ? 'Location permission was denied. Allow location for this site in your phone settings.' : 'Could not get your location.')),
      { enableHighAccuracy: false, timeout: 20000, maximumAge: 600000 });
  });
}

// ---------- data loading ----------

async function loadKB() {
  const names = ['hatches', 'flies', 'steelhead', 'rating', 'rivers', 'salmon', 'report-signals'];
  const files = await Promise.all(names.map((n) => fetch(`knowledge/${n}.json`).then((r) => r.json())));
  return Object.fromEntries(names.map((n, i) => [n, files[i]]));
}

// ---------- river profiles ----------

// "Pere Marquette River at Scottville, MI" -> "MI"
const stateOf = (name) => { const m = /(?:,\s*|\s)([A-Z]{2})$/.exec((name || '').trim()); return m ? m[1] : null; };

// The river part of a gauge name, used to key profiles and notes: "pere marquette river|MI".
function riverKey(site) {
  if (!site || !site.name) return null;
  const river = site.name.replace(/,?\s*[A-Z]{2}$/, '')
    .split(/\s+(?:at|near|nr|below|bl|above|ab|abv|blw|downstream|upstream|@)\s+|,/i)[0].trim().toLowerCase();
  return `${river}|${stateOf(site.name) || ''}`;
}

// Built-in profile from knowledge/rivers.json, or one saved on this phone ("Build with Claude").
function riverProfile(site) {
  if (!site || !S.kb) return null;
  const key = riverKey(site);
  if (key && S.profiles[key]) return { ...S.profiles[key], local: true };
  const name = (site.name || '').toLowerCase(), st = stateOf(site.name);
  return S.kb.rivers.rivers.find((p) => (p.sites || []).includes(site.id)
    || ((!p.state || p.state === st) && (p.match || []).some((m) => name.includes(m))
      && !(p.exclude || []).some((x) => name.includes(x)))) || null;
}

async function selectSite(basic) {
  S.site = { ...basic }; S.manual = false; S.loading = 'Getting river conditions…';
  S.wx = null; S.stats = null; S.flow = null; S.offline = false; S.loadError = null;
  render();
  const id = basic.id;
  try {
    const d = await getSite(id);
    const codeName = (n) => !n || /^USGS( gauge)? \d+$/.test(n);
    const name = codeName(basic.name) ? d.name : basic.name;
    S.site = { ...basic, ...d, name, fetchedAt: Date.now() };
    store.set(`site:${id}`, S.site);
    // Older versions saved some rivers under their gauge number; fix the name.
    const fav = S.favorites.find((f) => f.id === id);
    if (fav && fav.name !== name && !codeName(name)) { fav.name = name; store.set('favorites', S.favorites); }
  } catch (e) {
    const cached = await store.get(`site:${id}`);
    if (cached) { S.site = cached; S.offline = true; } else S.loadError = 'Could not reach the gauge, and there is no saved copy.';
  }
  S.stats = await store.get(`stats:${id}`);
  if (!S.stats && navigator.onLine) {
    S.stats = await getFlowStats(id);
    if (S.stats) store.set(`stats:${id}`, S.stats);
  }
  try {
    S.wx = await getWeather(S.site.lat, S.site.lon);
    store.set(`wx:${id}`, S.wx);
  } catch (e) {
    S.wx = await store.get(`wx:${id}`); S.offline = true;
  }
  S.flow = flowBand(S.site.cfs, S.stats);
  await loadClaudeAnswers();
  S.loading = '';
  saveSession();
  render();
  if (S.site.lat != null) loadNoaa(S.site);
}

async function findNearMe() {
  // Start fresh: drop any earlier search so only one list shows.
  S.query = ''; S.loading = 'Finding your location…'; S.nearby = null; S.nearbyTitle = ''; render();
  try {
    S.gps = await gps();
  } catch (e) {
    S.loading = ''; render(); toast(e.message); return;
  }
  S.loading = 'Looking for river gauges nearby…'; render();
  try {
    S.nearby = await findNearby(S.gps.lat, S.gps.lon);
    S.nearbyTitle = 'Gauges near you';
    if (!S.nearby.length) toast('No active USGS gauges within about 100 miles. Try manual conditions.');
  } catch (e) {
    // Offline: offer saved favorites, closest first.
    S.nearby = S.favorites.map((f) => ({ ...f, dist: distanceMi(S.gps.lat, S.gps.lon, f.lat, f.lon), cachedOnly: true }))
      .sort((a, b) => a.dist - b.dist);
    S.nearbyTitle = 'Your saved rivers (no signal)';
    toast('No signal. Showing your saved rivers.');
  }
  S.loading = ''; render();
}

async function searchRivers(q) {
  q = q.trim();
  if (q.length < 3) { toast('Type at least 3 letters.'); return; }
  S.query = q; S.nearby = null; S.nearbyTitle = ''; S.loading = `Searching for "${q}"…`; render();
  try {
    const r = await searchByName(q);
    S.nearby = r.sites;
    S.nearbyTitle = r.kind === 'place' ? `Gauges near ${r.place}` : `Live gauges matching "${q}"`;
  } catch (e) {
    S.nearby = []; S.nearbyTitle = `"${q}"`;
    toast(navigator.onLine ? 'Search failed. Try again in a moment.' : 'Search needs signal. Your saved rivers still work offline.');
  }
  S.loading = ''; render();
}

async function tripPrep() {
  if (!S.favorites.length) { toast('Star some gauges first (tap ☆ on a river).'); return; }
  let ok = 0;
  for (const [i, f] of S.favorites.entries()) {
    S.prep = `Saving ${i + 1} of ${S.favorites.length}: ${f.name}`; render();
    try {
      const d = await getSite(f.id);
      await store.set(`site:${f.id}`, { ...f, ...d, name: f.name, fetchedAt: Date.now() });
      if (!(await store.get(`stats:${f.id}`))) { const st = await getFlowStats(f.id); if (st) await store.set(`stats:${f.id}`, st); }
      await store.set(`wx:${f.id}`, await getWeather(f.lat, f.lon));
      ok++;
    } catch (e) { /* keep going */ }
  }
  S.prep = `Saved ${ok} of ${S.favorites.length} rivers for offline use (${new Date().toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}).`;
  store.set('prepMsg', S.prep);
  render();
  updateFavScores();
}

// ---------- conditions → engine ----------

function manualWeather() {
  const i = S.inputs;
  return {
    cloud: { sun: 10, cloudy: 85, rain: 95 }[i.sky], precip: i.sky === 'rain' ? 0.05 : 0,
    windMph: { calm: 3, breezy: 8, windy: 16 }[i.wind], airF: null, pressureTrend: i.pressure,
  };
}

function currentConditions() {
  const base = S.manual ? condFor(null, S.wx, null, true) : condFor(S.site, S.wx, S.flow, true);
  return applyObserved(base);
}

// ---------- what you're seeing (on-the-water observations, kept 3 hours per river) ----------

const obsKey = () => (S.manual ? 'manual' : riverKey(S.site));
function currentObs() {
  const o = S.observed[obsKey()];
  return o && Date.now() - o.at < OBS_MAX_AGE_MS ? o : null;
}

// Your observations override the gauge trend, add rain, and outrank report signals.
function applyObserved(cond) {
  const o = currentObs();
  const sig = observationSignals(o);
  if (!sig) return cond;
  const out = { ...cond, observed: o, reportSignals: mergeSignals(sig, cond.reportSignals) };
  if (sig.trend) out.flowTrend = sig.trend;
  if (sig.rain) out.weather = { ...(cond.weather || {}), precip: Math.max(0.05, (cond.weather || {}).precip || 0), cloud: Math.max(85, (cond.weather || {}).cloud || 0) };
  return out;
}

const OBS_LABEL = { rising: 'Rising', chasing: 'Chasing / boils', salmon: 'Salmon moving', steelhead: 'Steelhead showing', nothing: 'Nothing happening',
  caddis: 'Caddis', mayflies: 'Mayflies', midges: 'Midges', stoneflies: 'Stoneflies', hoppers: 'Hoppers', none: 'No bugs',
  up: 'Water coming up', rain: 'Rain started', dropping: 'Water dropping' };
const obsText = (o) => [...(o.fish || []), ...(o.bugs || []), ...(o.water || [])]
  .map((v) => OBS_LABEL[v] || v.replace(/\b\w/g, (ch) => ch.toUpperCase())).join(', ');

async function toggleObs(group, value) {
  const key = obsKey();
  const o = currentObs() || { at: Date.now(), fish: [], bugs: [], water: [] };
  const list = new Set(o[group]);
  // "Nothing happening" / "No bugs" can't be combined with anything else in their group.
  const exclusive = { fish: 'nothing', bugs: 'none' }[group];
  if (list.has(value)) list.delete(value);
  else {
    if (value === exclusive) list.clear(); else list.delete(exclusive);
    if (group === 'water' && (value === 'up' || value === 'dropping')) { list.delete('up'); list.delete('dropping'); }
    list.add(value);
  }
  o[group] = [...list];
  o.at = Date.now();
  S.observed[key] = o;
  await store.set('observed', S.observed);
}

// Engine input for a gauge (or manual mode when site is null), using "Your spot" choices.
// useOverride: apply the thermometer reading (only for the river you're actually on).
function condFor(site, wx, flow, useOverride) {
  const i = S.inputs;
  const override = useOverride && i.tempOverride !== '' && !isNaN(+i.tempOverride) ? Math.round(+i.tempOverride) : null;
  let waterTempF = override, tempSource = override != null ? 'your reading' : null;
  if (waterTempF == null && site && site.waterTempF != null) { waterTempF = site.waterTempF; tempSource = 'gauge'; }
  const sun = sunFor(wx);
  const lon = site ? site.lon : S.gps ? S.gps.lon : null;
  return {
    species: i.species, clarity: i.clarity, waterType: i.waterType, depthFt: +i.depthFt,
    waterTempF, tempSource,
    flowBand: site ? flow && flow.band : (i.flowBand === 'unknown' ? null : i.flowBand),
    flowTrend: site ? site.trend : i.trend,
    weather: site ? wx || null : manualWeather(),
    sunrise: sun.sunrise, sunset: sun.sunset,
    region: regionFor(lon),
    river: site ? riverProfile(site) : null,
    // Latest local reports nudge the setups, but only for the river you're actually on.
    reportSignals: site && useOverride ? extractSignals(reportsFor(riverProfile(site)), S.kb['report-signals']) : null,
    now: new Date(),
  };
}

// ---------- conditions score ----------

const minScore = () => (S.gear.minScore != null ? S.gear.minScore : S.kb.rating.defaultMinScore);

function currentRating() {
  if (!S.kb || (!S.site && !S.manual)) return null;
  return rateConditions(currentConditions(), S.kb);
}

// Today (actual conditions) plus the next 3 days (forecast). Site mode only.
function forecastRatings() {
  if (S.manual || !S.wx || !S.wx.days || !S.wx.days.length) return [];
  const base = currentConditions();
  const days = S.wx.days.slice(0, 4);
  const avg = (d) => (d.max + d.min) / 2;
  const month = new Date().getMonth() + 1;
  const baseT = base.waterTempF != null ? base.waterTempF : estimateWaterTempF(S.wx.past3AvgAirF, month);
  const worse = { clear: 'slight', slight: 'stained', stained: 'muddy', muddy: 'muddy' };
  return days.map((d, i) => {
    if (i === 0) return { date: d.date, rating: currentRating(), src: 'now', notes: [], code: d.code, max: d.max, min: d.min };
    const date = new Date(`${d.date}T13:00`);
    // Water temp follows air temp slowly.
    const waterTempF = Math.round(Math.max(33, Math.min(80, baseT + 0.35 * (avg(d) - avg(days[0])))));
    let flowBandX = base.flowBand, trend = 'steady', src = 'weather', clarity = base.clarity;
    const notes = [];
    const fc = S.noaaFc && S.noaaFc[d.date];
    if (fc != null && S.stats) {
      const fbx = flowBand(fc, S.stats, date);
      if (fbx) { flowBandX = fbx.band; src = 'noaa'; notes.push(`NOAA forecast: ${fc.toLocaleString()} cfs`); }
      const prev = S.noaaFc[days[i - 1].date];
      if (prev) trend = fc > prev * 1.08 ? 'rising' : fc < prev * 0.92 ? 'falling' : 'steady';
    }
    const prevRain = days[i - 1].precip || 0, rain = d.precip || 0;
    if (prevRain >= 0.5 || rain >= 0.75) {
      clarity = worse[clarity];
      if (src !== 'noaa') trend = 'rising';
      notes.push(`Heavy rain (${Math.max(prevRain, rain).toFixed(1)} in) may raise and color the river`);
    }
    const cloud = d.code <= 1 ? 15 : d.code === 2 ? 50 : 90;
    const cond = {
      ...base, now: date, tod: 'afternoon', waterTempF, tempEstimated: true, flowBand: flowBandX, flowTrend: trend, clarity,
      weather: { cloud, precip: d.code >= 51 ? 0.05 : 0, windMph: null, pressureTrend: 'steady', airF: d.max },
    };
    return { date: d.date, rating: rateConditions(cond, S.kb), src, notes, code: d.code, max: d.max, min: d.min };
  });
}

// Scores for saved rivers, from saved data. Refreshes stale data in the background when online.
let favRefreshing = false;
async function updateFavScores(forceFetch = false) {
  if (favRefreshing || !S.favorites.length || !S.kb) return;
  favRefreshing = true;
  try {
    for (const f of S.favorites) {
      let site = await store.get(`site:${f.id}`);
      let wx = await store.get(`wx:${f.id}`);
      let stats = await store.get(`stats:${f.id}`);
      const stale = !site || !site.fetchedAt || Date.now() - site.fetchedAt > 30 * 60e3;
      if (navigator.onLine && (stale || forceFetch)) {
        try {
          const d = await getSite(f.id);
          site = { ...f, ...d, name: f.name, fetchedAt: Date.now() };
          await store.set(`site:${f.id}`, site);
          if (!stats) { stats = await getFlowStats(f.id); if (stats) await store.set(`stats:${f.id}`, stats); }
          wx = await getWeather(f.lat, f.lon); await store.set(`wx:${f.id}`, wx);
        } catch (e) { /* keep saved data */ }
      }
      if (!site) { S.favScores[f.id] = null; continue; }
      const r = rateConditions(condFor(site, wx, flowBand(site.cfs, stats), false), S.kb);
      S.favScores[f.id] = { ...r, at: site.fetchedAt };
      if (S.tab === 'water' && isPicking()) render();
    }
  } finally { favRefreshing = false; }
}

async function loadNoaa(site) {
  S.noaaFc = null;
  try {
    const key = `noaa:${site.id}`;
    let info = await store.get(key);
    if (!info || Date.now() - info.checkedAt > 7 * 864e5) {
      info = { lid: await findNoaaGauge(site.id, site.lat, site.lon), checkedAt: Date.now() };
      await store.set(key, info);
    }
    if (info.lid) {
      S.noaaFc = await getFlowForecast(info.lid);
      if (S.noaaFc) store.set(`noaafc:${site.id}`, S.noaaFc);
    }
  } catch (e) {
    S.noaaFc = await store.get(`noaafc:${site.id}`);
  }
  if (S.noaaFc && S.site && S.site.id === site.id && S.tab === 'water' && !isPicking()) render();
}

// ---------- screens ----------

function render() {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
  const net = document.getElementById('net');
  net.textContent = navigator.onLine ? '' : '● Offline';
  const html = { water: viewWater, setups: viewSetups, log: viewLog, gear: viewGear }[S.tab]();
  $app.innerHTML = html;
}

// The River tab has two states: choosing a river (picker), or a river is chosen
// (compact bar at the top + conditions + "Your spot").
const isPicking = () => S.picking || (!S.site && !S.manual);

function viewWater() {
  return isPicking() ? viewPicker() : viewChosen();
}

function viewPicker() {
  let h = '';
  const canGoBack = S.site || S.manual;
  h += `<div class="card"><div class="site-head"><h2>Where are you fishing?</h2>${canGoBack ? '<button class="linkish" data-act="back">Cancel</button>' : ''}</div>
    <form class="inline" data-act="search" style="margin-bottom:10px">
      <span class="qwrap"><input type="search" id="q" enterkeyhint="search" placeholder="River or town, e.g. Pere Marquette" value="${esc(S.query || '')}" autocomplete="off">
        <button type="button" class="qclear" data-act="clearq" aria-label="Clear search">✕</button></span>
      <button type="submit" style="flex:none">Search</button>
    </form>
    <div class="btn-row">
      <button class="btn-primary" data-act="near">📍 Find gauges near me</button>
    </div>
    <p class="small muted" style="margin:8px 0 0">No gauge on your river? <button class="linkish" data-act="manual">Enter conditions yourself</button></p>`;
  if (S.loading) h += `<p style="margin:14px 0 0"><span class="spin"></span>${esc(S.loading)}</p>`;
  if (S.nearby) {
    if (S.nearbyTitle) h += `<h3>${esc(S.nearbyTitle)}</h3>`;
    h += S.nearby.length ? `<ul class="site-list">${S.nearby.map((s, k) => `<li><button data-act="pick" data-k="${k}">
      <span><span class="nm">${esc(s.name)}</span><br><span class="small muted">${s.cachedOnly ? 'saved offline' : [s.cfs != null ? `${Math.round(s.cfs).toLocaleString()} cfs` : '', s.waterTempF != null ? `${s.waterTempF}°F` : ''].filter(Boolean).join(' · ')}</span></span>
      <span class="meta">${s.dist != null ? `${s.dist.toFixed(1)} mi` : '›'}</span></button></li>`).join('')}</ul>` : `<p class="muted">${S.query ? 'No live gauges found. Try a shorter name (e.g. "Pere Marquette"), or a nearby town like "Baldwin, MI".' : 'No gauges found nearby.'}</p>`;
  }
  if (S.favorites.length) {
    const min = minScore();
    h += `<h3>★ Saved rivers</h3><ul class="site-list">${S.favorites.map((f, k) => {
      const sc = S.favScores[f.id];
      const badge = sc ? `<span class="chip-score lvl-${sc.level}${sc.score < min ? ' below' : ''}">${sc.score}</span>` : '<span class="meta">›</span>';
      return `<li><button data-act="fav" data-k="${k}"><span><span class="nm">${esc(f.name)}</span>${sc ? `<br><span class="small muted">${esc(sc.label)} · ${ago(sc.at)}</span>` : ''}</span>${badge}</button></li>`;
    }).join('')}</ul>
      <button style="width:100%;margin-top:8px" data-act="prep">⬇️ Download saved rivers for offline</button>
      ${S.prep ? `<p class="small muted">${esc(S.prep)}</p>` : ''}`;
  }
  h += `</div>`;
  if (!S.nearby && !S.loading && !canGoBack) {
    h += `<div class="card"><p class="muted" style="margin:0">Search any US river by name, or tap <b>Find gauges near me</b> when you're on the water. You'll get live flow and water temp from the nearest USGS gauge, plus weather, then the best flies and rig for right now.</p></div>`;
  }
  return h;
}

function viewSelectedBar() {
  const s = S.site;
  let name, sub, star = '';
  if (S.manual) { name = 'Manual conditions'; sub = 'Set the river conditions below'; }
  else {
    name = s.name;
    sub = S.loading ? `<span class="spin"></span>${esc(S.loading)}`
      : `USGS ${esc(s.id)}${s.time ? ` · reading ${ago(s.time)}` : ''}${S.offline ? ' · <b>offline copy</b>' : ''}`;
    const isFav = S.favorites.some((f) => f.id === s.id);
    star = `<button class="star" data-act="star" aria-label="${isFav ? 'Remove from saved rivers' : 'Save river'}">${isFav ? '★' : '☆'}</button>`;
  }
  return `<div class="selbar"><span class="ck" aria-hidden="true">✓</span>
    <div class="selname"><b>${esc(name)}</b><div class="small muted">${sub}</div></div>
    ${star}<button class="selchange" data-act="change">Change</button></div>`;
}

// Circular score gauge.
function scoreRing(score, level, size = 76) {
  const r = 32, c = 2 * Math.PI * r, off = c * (1 - Math.max(0, Math.min(100, score)) / 100);
  return `<svg class="ring lvl-${level}" width="${size}" height="${size}" viewBox="0 0 80 80" role="img" aria-label="Score ${score} out of 100">
    <circle cx="40" cy="40" r="${r}" fill="none" stroke="var(--line)" stroke-width="8"/>
    <circle cx="40" cy="40" r="${r}" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round"
      stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 40 40)"/>
    <text x="40" y="47" text-anchor="middle" font-size="22" font-weight="800" fill="var(--ink)">${score}</text></svg>`;
}

function viewScore() {
  const r = currentRating();
  if (!r) return '';
  const min = minScore();
  let h = `<div class="card score-card">
    <div class="score-row">${scoreRing(r.score, r.level)}
      <div><div class="score-label lvl-${r.level}">${esc(r.label)} <span class="muted small">· ${r.score}/100</span></div>
      <div class="small">${esc(r.summary)}</div></div></div>`;
  if (r.score < min) h += `<div class="alert caution" style="margin:10px 0 0">Below your minimum of ${min}. Probably not worth the trip today.</div>`;
  h += `<details class="more"><summary>How this score works</summary>
    ${r.factors.map((f) => (f.bonus
    ? `<div class="factor"><div class="factor-top"><span>${esc(f.label)}</span><b>${f.pts > 0 ? '+' : ''}${f.pts}</b></div><div class="small muted">${esc(f.note)}</div></div>`
    : `<div class="factor"><div class="factor-top"><span>${esc(f.label)}</span><b>${f.pts}/${f.max}</b></div>
      <div class="bar"><span style="width:${Math.round(f.frac * 100)}%"></span></div><div class="small muted">${esc(f.note)}</div></div>`)).join('')}
    <p class="small muted">Scores use your "Your spot" choices above (species and clarity matter most). Tune the weights in knowledge/rating.json.</p></details>`;
  return h + `</div>`;
}

// Today plus the next 3 days, scored.
function viewForecast() {
  const min = minScore();
  let h = '';
  const fc = forecastRatings();
  if (fc.length > 1) {
    const dayName = (d, i) => (i === 0 ? 'Today' : new Date(`${d}T12:00`).toLocaleDateString([], { weekday: 'short' }));
    h += `<div class="card"><h2>Next few days</h2><div class="fc">${fc.map((d, i) => `<div class="${d.rating.score >= min ? '' : 'below'}">
      <b>${dayName(d.date, i)}</b><br><span class="chip-score lvl-${d.rating.level}">${d.rating.score}</span><br>
      <span class="small">${d.max}°/${d.min}°</span><br><span class="muted small">${esc(codeText(d.code))}</span></div>`).join('')}</div>`;
    const notes = fc.flatMap((d, i) => d.notes.map((n) => `${dayName(d.date, i)}: ${n}`));
    const noaa = fc.some((d) => d.src === 'noaa');
    h += `<p class="small muted" style="margin:8px 0 0">${notes.map(esc).join('<br>')}${notes.length ? '<br>' : ''}Future days: ${noaa ? 'NOAA river forecast plus' : 'no NOAA flow forecast for this gauge right now, so based on'} the weather forecast. Water temps are estimated.</p></div>`;
  }
  return h;
}

// Species chips; fish the river's profile doesn't list are shown faded (still tappable).
function speciesChips(current, profile) {
  const opts = [['trout', 'Trout'], ['steelhead', 'Steelhead'], ['salmon', 'Salmon']];
  return `<div class="chips">${opts.map(([v, l]) => {
    const absent = profile && !(profile.species || []).includes(v);
    return `<button class="chip ${current === v ? 'on' : ''} ${absent ? 'absent' : ''}" data-act="set" data-f="species" data-v="${v}"${absent ? ' title="Not known in this river"' : ''}>${l}</button>`;
  }).join('')}</div>`;
}

// Banner when a run is on: "🐟 King salmon: peak of the run on the Pere Marquette".
function viewRunAlert() {
  if (S.manual || !S.site) return '';
  const p = riverProfile(S.site);
  if (!p) return '';
  const month = new Date().getMonth() + 1, cur = S.inputs.species;
  const live = ['salmon', 'steelhead'].map((sp) => ({ sp, ri: runInfo(p, sp, month) }))
    .filter((x) => x.ri.status === 'peak' || x.ri.status === 'in')
    .sort((a, b) => (a.ri.status === 'peak' ? -1 : 1) - (b.ri.status === 'peak' ? -1 : 1));
  if (!live.length) return '';
  return live.map(({ sp, ri }) => {
    const what = ri.status === 'peak' ? 'peak of the run' : 'fish are in the river';
    const btn = cur === sp ? '<span class="small">You\'re set up for it ✓</span>'
      : `<button class="chip on" data-act="set" data-f="species" data-v="${sp}">Fish for ${sp}</button>`;
    return `<div class="run-alert"><div>🐟 <b>${esc(ri.run.label)}</b>: ${what} on the ${esc(p.name)}.</div>${btn}</div>`;
  }).join('');
}

// Remembers which <details> sections are open across re-renders: data-keep="key".
function keep(key, defaultOpen = false) {
  const open = S.openState[key] ?? defaultOpen;
  return `data-keep="${esc(key)}"${open ? ' open' : ''}`;
}

const CLARITY_LABEL = { clear: 'Clear', slight: 'Slight tint', stained: 'Stained', muddy: 'Muddy' };
const WATER_LABEL = { riffle: 'Riffle', run: 'Run', pool: 'Pool', pocket: 'Pocket water', flat: 'Flat/glide' };

// "Your spot": a one-line summary that opens to the choices that drive the score and setups.
function viewSpot() {
  const i = S.inputs;
  const temp = i.tempOverride !== '' ? `${i.tempOverride}°F` : (S.site && S.site.waterTempF != null && !S.manual ? `${S.site.waterTempF}°F gauge` : 'temp estimated');
  const summary = [SPECIES_LABEL[i.species] || 'Trout', CLARITY_LABEL[i.clarity], `${WATER_LABEL[i.waterType]} ${i.depthFt} ft`, temp].join(' · ');
  const o = currentObs();
  const seen = o && obsText(o);
  return `<details class="card spot" ${keep('spot', !S.hadSession)}>
    <summary><span class="spot-k">Your spot</span><span class="spot-v">${esc(summary)}${seen ? `<span class="obs-line">👀 ${esc(seen)} · ${ago(o.at)}</span>` : ''}</span><span class="spot-edit">Change</span></summary>
    ${viewObserve(o)}
    <label class="field">Fishing for</label>${speciesChips(i.species, S.manual ? null : riverProfile(S.site))}
    <label class="field">Water clarity</label>${chips('clarity', [['clear', 'Clear'], ['slight', 'Slight tint'], ['stained', 'Stained'], ['muddy', 'Muddy']], i.clarity)}
    <label class="field">Type of water</label>${chips('waterType', [['riffle', 'Riffle'], ['run', 'Run'], ['pool', 'Pool'], ['pocket', 'Pocket water'], ['flat', 'Flat / glide']], i.waterType)}
    <label class="field">Depth where fish hold: <span id="dv">${i.depthFt}</span> ft</label>
    <input type="range" min="1" max="10" step="0.5" value="${i.depthFt}" data-in="depthFt">
    <label class="field">Water temp from your thermometer (°F, optional)</label>
    <input type="number" inputmode="decimal" placeholder="${S.site && S.site.waterTempF != null && !S.manual ? `gauge says ${S.site.waterTempF}°F` : 'e.g. 52'}" value="${esc(i.tempOverride)}" data-in="tempOverride">
  </details>`;
}

// "What are you seeing?" chips. Likely hatches for today come first among the bugs.
function viewObserve(o) {
  const has = (g, v) => !!(o && (o[g] || []).includes(v));
  const chip = (g, v, label) => `<button class="chip ${has(g, v) ? 'on' : ''}" data-act="obs" data-g="${g}" data-v="${esc(v)}">${esc(label)}</button>`;
  let likely = [];
  try {
    const c = prepare({ ...(S.manual ? condFor(null, S.wx, null, true) : condFor(S.site, S.wx, S.flow, true)), reportSignals: null });
    likely = scoreHatches(allHatches(S.kb, c.river), c).slice(0, 3).map((x) => x.h.name.replace(/\s*\(.*$/, ''));
  } catch (e) { /* no hatch info */ }
  const generic = ['caddis', 'mayflies', 'midges', 'stoneflies', 'hoppers'];
  return `<div class="observe"><div class="observe-head"><b>What are you seeing?</b>
      ${o ? `<button class="linkish small" data-act="obsclear">Clear</button>` : '<span class="small muted">Tap what\'s happening now</span>'}</div>
    <div class="obs-group"><span class="obs-k">Fish</span><div class="chips">${['rising', 'chasing', 'salmon', 'steelhead', 'nothing'].map((v) => chip('fish', v, OBS_LABEL[v])).join('')}</div></div>
    <div class="obs-group"><span class="obs-k">Bugs</span><div class="chips">${likely.map((n) => chip('bugs', n.toLowerCase(), n)).join('')}${generic.filter((g) => !likely.some((l) => l.toLowerCase().includes(g.slice(0, 5)))).map((v) => chip('bugs', v, OBS_LABEL[v])).join('')}${chip('bugs', 'none', 'No bugs')}</div></div>
    <div class="obs-group"><span class="obs-k">Water</span><div class="chips">${chip('water', 'up', 'Coming up')}${chip('water', 'dropping', 'Dropping')}${chip('water', 'rain', 'Rain started')}</div></div>
    <p class="small muted" style="margin:4px 0 0">Your observations adjust the score and setups for the next 3 hours, and go to Claude when you ask.</p></div>`;
}

// Short spec line for a setup: first fly · rod · tippet.
function keySpec(s) {
  const tip = s.rig.find((p) => p.kind === 'leader') || s.rig.find((p) => p.kind === 'tippet');
  return [s.flies[0] && s.flies[0].name, s.rod.text.replace(/^your /, ''), tip && tip.label].filter(Boolean).join(' · ');
}

// The top setup, right on the River tab.
function viewBestBet() {
  const r = recommend(currentConditions(), S.kb, S.gear, S.catches);
  const stop = r.warnings.find((w) => w.level === 'stop');
  const s = r.setups[0];
  if (!s) return '';
  return `<div class="card bestbet">
    <div class="rank">🎣 Best bet right now</div>
    <h2>${esc(s.title)}</h2>
    ${stop ? `<p class="danger" style="margin:0 0 6px">🛑 ${esc(stop.text)}</p>` : ''}
    <p class="spec">${esc(keySpec(s))}</p>
    <p class="small" style="margin:4px 0 0">${esc(s.why[0] || '')}</p>
    <p style="margin:10px 0 0"><button class="linkish" data-tab="setups">See all setups, rigs and flies →</button></p>
  </div>`;
}

function viewChosen() {
  let h = viewSelectedBar();
  if (S.loading) return h + viewSpot();
  h += viewSpot();
  h += viewRunAlert();
  h += viewScore();
  h += viewBestBet();
  h += viewForecast();
  if (S.manual) h += viewManual();
  else h += viewConditions() + viewAbout();
  h += `<div class="sticky-cta"><button class="btn-primary" data-tab="setups">🎣 Setups for this spot</button></div>`;
  return h;
}

// ---------- About this river: profile, reports, my notes ----------

const MONTH_ABBR = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const SPECIES_LABEL = { trout: 'Trout', steelhead: 'Steelhead', salmon: 'Salmon' };

function runCalendar(runs, month) {
  return `<div class="runcal">${runs.map((r) => `<div class="runcal-row"><div class="runcal-label">${esc(r.label)}</div>
    <div class="runcal-months">${MONTH_ABBR.map((m, k) => {
      const mo = k + 1, cls = (r.peak || []).includes(mo) ? 'peak' : r.months.includes(mo) ? 'in' : '';
      return `<span class="${cls}${mo === month ? ' now' : ''}" title="${cls || 'no run'}">${m}</span>`;
    }).join('')}</div></div>`).join('')}
    <div class="small muted">Dark = peak · light = fish in the river · outlined = this month</div></div>`;
}

const ageText = (iso) => {
  if (!iso) return '';
  // Calendar days between the post date and today, in local time.
  const day = (t) => { const x = new Date(t); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const d = Math.round((day(Date.now()) - day(iso)) / 864e5);
  return d <= 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`;
};

// Latest shop/guide reports and DNR sections for this river, from data/reports.json.
function reportsFor(p) {
  const R = S.reports;
  if (!R || !p) return { items: [], dnr: null };
  const items = [];
  for (const src of [...(p.feeds || []), ...(p.reports || [])]) {
    const f = R.feeds && R.feeds[src.url];
    if (f) for (const it of f.items) items.push({ ...it, source: f.name || src.name });
  }
  items.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  let dnr = null;
  const b = (R.dnr || [])[0];
  if (b && (p.dnr || []).length) {
    const keys = p.dnr.map((k) => k.toLowerCase());
    const secs = b.sections.filter((s) => keys.some((k) => s.place.toLowerCase().includes(k) || s.text.toLowerCase().includes(k))).slice(0, 3);
    if (secs.length) dnr = { ...b, sections: secs };
  }
  return { items: items.slice(0, 6), dnr };
}

function viewReports(p) {
  let h = '<h3>Recent fishing reports</h3>';
  const { items, dnr } = reportsFor(p);
  const siteOf = (u) => { try { return new URL(u).origin; } catch (e) { return u; } };
  const itemHtml = (it) => `<div class="report"><div class="report-src">📰 From <a href="${esc(siteOf(it.url))}" target="_blank" rel="noopener">${esc(it.source)}</a>
    <span class="muted">· ${it.date ? new Date(it.date).toLocaleDateString([], { month: 'short', day: 'numeric' }) : ''} (${ageText(it.date)})</span></div>
    <b>${esc(it.title)}</b>${it.excerpt ? `<div class="small">${esc(it.excerpt)}</div>` : ''}
    <a href="${esc(it.url)}" target="_blank" rel="noopener">Read the full report on ${esc(it.source.replace(/\s*\(.*\)$/, ''))}'s site ↗</a></div>`;
  if (items.length) {
    h += itemHtml(items[0]);
    if (items.length > 1) h += `<details class="more"><summary>More reports (${items.length - 1})</summary>${items.slice(1).map(itemHtml).join('')}</details>`;
  }
  if (dnr) {
    h += `<div class="report"><div class="report-src">🏛️ From <a href="https://www.michigan.gov/dnr/things-to-do/fishing/weekly" target="_blank" rel="noopener">Michigan DNR</a>
      <span class="muted">· ${new Date(dnr.date).toLocaleDateString([], { month: 'short', day: 'numeric' })} (${ageText(dnr.date)})</span></div>
      <b>${esc(dnr.title)}</b>${dnr.sections.map((s) => `<div class="small"><b>${esc(s.place)}:</b> ${esc(s.text.length > 450 ? s.text.slice(0, 450) + '…' : s.text)}</div>`).join('')}
      <a href="${esc(dnr.url)}" target="_blank" rel="noopener">Full DNR report ↗</a></div>`;
  }
  const withItems = new Set(Object.keys((S.reports && S.reports.feeds) || {}));
  const links = (p ? p.reports || [] : []).filter((l) => !withItems.has(l.url));
  if (links.length) h += `<p class="small" style="margin:8px 0 0">More reports: ${links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.name)} ↗</a>`).join(' · ')}</p>`;
  if (items.length || dnr) h += '<p class="small muted" style="margin:6px 0 0">Report previews are shared from each source\'s public feed. Tap through to read the full report on their site.</p>';
  if (!items.length && !dnr && !links.length) {
    h += `<p class="small muted" style="margin:0">${S.reports ? 'No report sources for this river yet.' : 'Reports update daily from local shops and the Michigan DNR (not loaded yet).'}</p>`;
  }
  return h;
}

function viewAbout() {
  const site = S.site, p = riverProfile(site), key = riverKey(site);
  const month = new Date().getMonth() + 1;
  // Each part folds to a one-line summary so the card stays short.
  const section = (k, title, summary, body, open = false) => `<details class="sec" ${keep(`about-${k}`, open)}>
    <summary><b>${title}</b>${summary ? `<span class="sec-sum">${summary}</span>` : ''}</summary>${body}</details>`;
  let h = '<div class="card about"><h2>About this river</h2>';
  if (p) {
    h += `<p class="small muted" style="margin:0 0 6px">${esc(p.name)} profile${p.local ? ', saved on this phone' : ''} · ${(p.species || []).map((s) => SPECIES_LABEL[s] || esc(s)).join(', ')}</p>`;
    if ((p.runs || []).length) {
      const live = p.runs.filter((r) => r.months.includes(month));
      const sum = live.length ? live.map((r) => `${esc(r.label)}${(r.peak || []).includes(month) ? ': peak now' : ': in now'}`).join(' · ') : 'No runs this month';
      h += section('runs', 'Runs', sum, runCalendar(p.runs, month));
    }
    const lib = S.kb.rivers.hatchLibrary || {};
    const hs = (p.hatches || []).map((x) => (typeof x === 'string' ? lib[x] : x)).filter(Boolean);
    if (hs.length) h += section('hatches', 'Signature hatches', `${hs.length}`, `<ul class="notes">${hs.map((x) => `<li><b>${esc(x.name)}</b>: ${monthRange(x.months)}${x.time ? `, ${esc(x.time.join('/'))}` : ''}${x.dry && x.dry[0] ? ` · ${esc(x.dry[0])}` : ''}</li>`).join('')}</ul>`);
    if ((p.notes || []).length) {
      h += section('notes', 'Local knowledge', `${p.notes.length}`, `<ul class="notes">${p.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
        ${p.source ? `<p class="small muted">Source: ${esc(p.source)}. Seasonal guide only: always check current regulations.</p>` : ''}`);
    }
  } else {
    h += `<p style="margin-top:0">No profile for this river yet, so setups use conditions only. Build one with Claude to add which fish are here, run timing, signature hatches and local report sources.</p>`;
  }
  const rep = reportsFor(p);
  const newest = rep.items[0];
  const repSum = newest ? `${esc(newest.source)}, ${ageText(newest.date)}` : rep.dnr ? `Michigan DNR, ${ageText(rep.dnr.date)}` : 'none yet';
  h += section('reports', 'Latest reports', repSum, viewReports(p).replace('<h3>Recent fishing reports</h3>', ''), true);
  const note = S.riverNotes[key] || '';
  h += section('mynotes', 'My notes', note ? esc(note.slice(0, 40)) + (note.length > 40 ? '…' : '') : 'add your own',
    `<textarea data-rivernotes="${esc(key)}" style="min-height:70px" placeholder="Your own tips for this river (spots, flies that worked)…">${esc(note)}</textarea>`);
  if (!p || p.local) {
    h += `<div class="btn-row" style="margin-top:12px"><button data-act="buildprofile">💬 ${p ? 'Update' : 'Build'} profile with Claude ↗</button></div>
      <details class="more"${S.profileOpen ? ' open' : ''}><summary>Paste Claude's profile</summary>
      <p class="small muted" style="margin-top:0">Copy Claude's whole answer, then paste it here.</p>
      <textarea id="profpaste" style="min-height:80px" placeholder="Paste Claude's answer"></textarea>
      <div class="btn-row" style="margin-top:8px"><button data-act="profclip">📋 Paste from clipboard</button><button data-act="saveprofile">Save profile</button></div></details>`;
  }
  if (p && p.local) h += `<p class="small" style="margin:8px 0 0"><button class="linkish" data-act="shareprofile">Copy profile to share</button> · <button class="linkish danger" data-act="delprofile">Remove profile</button></p>`;
  return h + '</div>';
}

function buildProfilePrompt(site) {
  const key = riverKey(site), [river, st] = key.split('|');
  return [
    'I use a fly fishing app called Fly Buddy. Please create a river profile for:',
    `${river.replace(/\b\w/g, (c) => c.toUpperCase())}${st ? `, ${st}` : ''} (USGS gauge ${site.id}: "${site.name}").`,
    '',
    'Use what you know, and search the web if you can. Include:',
    '- which of these the river holds: trout, steelhead, salmon',
    '- for steelhead and salmon: the months fish are in the river, and the peak months',
    '- up to 6 important hatches: name, months, water temp range (°F), time of day, dry/emerger/nymph patterns with hook sizes',
    '- up to 5 short practical notes (what it is known for, access, regulations to check)',
    '- up to 5 local fly shops or guides that post regular fishing reports online (name and the URL of their reports page)',
    'Keep it factual and general: say "check current regulations" rather than quoting rules.',
    '',
    'Reply briefly, then end with this block as valid JSON (same keys), so I can paste it into the app:',
    'FLYBUDDY-PROFILE',
    '{"species":["trout","steelhead"],"runs":[{"species":"steelhead","label":"Steelhead (fall and spring)","months":[10,11,12,1,2,3,4],"peak":[3,4]}],"hatches":[{"name":"Hendricksons","months":[4,5],"temp":[50,58],"time":["afternoon"],"dry":["Hendrickson Parachute #12-14"],"emerger":[],"nymph":["Pheasant Tail #12-14"],"size":14}],"notes":["..."],"reports":[{"name":"Shop name","url":"https://..."}]}',
    'FLYBUDDY-END',
  ].join('\n');
}

// Pull the JSON profile out of Claude's reply and keep only well-formed, sensible values.
function parseProfile(text, site) {
  const m = /FLYBUDDY-PROFILE([\s\S]*?)(FLYBUDDY-END|$)/i.exec(text || '');
  const body = m ? m[1] : text || '';
  const a = body.indexOf('{'), b = body.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('No profile block found. Copy Claude\'s whole answer, including the FLYBUDDY-PROFILE part.');
  const raw = JSON.parse(body.slice(a, b + 1));
  const months = (xs) => [...new Set((Array.isArray(xs) ? xs : []).map(Number).filter((n) => n >= 1 && n <= 12))];
  const strs = (xs, n, len = 120) => (Array.isArray(xs) ? xs : []).map((x) => String(x).trim().slice(0, len)).filter(Boolean).slice(0, n);
  const SP = ['trout', 'steelhead', 'salmon'];
  const species = [...new Set(strs(raw.species, 3).map((s) => s.toLowerCase()).filter((s) => SP.includes(s)))];
  const runs = (Array.isArray(raw.runs) ? raw.runs : []).map((r) => ({
    species: String(r.species || '').toLowerCase(), label: String(r.label || r.species || 'Run').slice(0, 60),
    months: months(r.months), peak: months(r.peak),
  })).filter((r) => SP.includes(r.species) && r.months.length).slice(0, 6);
  const TIMES = ['morning', 'midday', 'afternoon', 'evening'];
  const hatches = (Array.isArray(raw.hatches) ? raw.hatches : []).map((x) => {
    const t = Array.isArray(x.temp) && x.temp.length === 2 ? x.temp.map(Number) : [45, 65];
    const time = strs(x.time, 4).map((s) => s.toLowerCase()).filter((s) => TIMES.includes(s));
    return {
      name: String(x.name || '').slice(0, 60), months: months(x.months), temp: t.every((v) => v > 30 && v < 85) ? t : [45, 65],
      time: time.length ? time : ['afternoon'], regions: ['all'], boost: [], base: 0.8,
      dry: strs(x.dry, 4), emerger: strs(x.emerger, 3), nymph: strs(x.nymph, 4), size: Math.min(24, Math.max(2, +x.size || 14)),
    };
  }).filter((x) => x.name && x.months.length).slice(0, 10);
  const reports = (Array.isArray(raw.reports) ? raw.reports : []).map((r) => ({ name: String(r.name || '').slice(0, 60), url: String(r.url || '') }))
    .filter((r) => r.name && /^https?:\/\/[^\s]+$/.test(r.url)).slice(0, 5);
  if (!species.length) throw new Error('The profile didn\'t list any of trout, steelhead or salmon.');
  const [river, st] = riverKey(site).split('|');
  return {
    name: river.replace(/\s+river$/, '').replace(/\b\w/g, (c) => c.toUpperCase()), match: [river], state: st || undefined,
    species, runs, hatches, notes: strs(raw.notes, 6, 240), dnr: [], feeds: [], reports,
    source: `Built with Claude, ${new Date().toLocaleDateString([], { month: 'short', year: 'numeric' })}`,
  };
}

async function saveProfileText(text) {
  try {
    const p = parseProfile(text, S.site);
    S.profiles[riverKey(S.site)] = p;
    await store.set('profiles', S.profiles);
    S.profileOpen = false;
    render();
    toast(`Profile saved: ${p.species.join(', ')}, ${p.runs.length} runs, ${p.hatches.length} hatches`);
  } catch (e) {
    toast(e instanceof SyntaxError ? 'That profile isn\'t valid JSON. Ask Claude to resend just the FLYBUDDY-PROFILE block.' : e.message);
  }
}

// Reports come from data/reports.json, which the GitHub Action refreshes daily.
// Read the repo copy on raw.githubusercontent.com first (newest), then the site's own copy.
async function loadReports() {
  const urls = [];
  const host = location.hostname;
  if (host.endsWith('.github.io')) {
    const owner = host.split('.')[0], repo = location.pathname.split('/')[1];
    if (repo) urls.push(`https://raw.githubusercontent.com/${owner}/${repo}/main/data/reports.json`);
  }
  urls.push('data/reports.json');
  for (const u of urls) {
    try {
      const r = await fetch(`${u}?t=${Math.floor(Date.now() / 600e3)}`, { cache: 'no-store' });
      if (!r.ok) continue;
      S.reports = await r.json();
      store.set('reports', S.reports);
      return;
    } catch (e) { /* try the next source */ }
  }
  S.reports = await store.get('reports');
}

function viewConditions() {
  const s = S.site, wx = S.wx, fl = S.flow;
  const sun = sunFor(wx);
  const bandCls = fl ? fl.band.replace(' ', '-') : '';
  // River name, gauge id and the save star live in the selected-river bar above.
  let h = `<div class="card"><h2>River conditions</h2>`;
  if (S.loadError) h += `<p class="danger">${esc(S.loadError)}</p>`;
  h += `<div class="stats">
    <div class="stat"><div class="k">Flow</div><div class="v">${s.cfs != null ? Math.round(s.cfs).toLocaleString() : '—'}<span class="small"> cfs</span></div>
      <div class="s">${fl ? `<span class="band ${bandCls}">${fl.band}</span> ${fl.pct}% of normal` : 'no history'}<br>${trendArrow(s.trend)}</div></div>
    <div class="stat"><div class="k">Water temp</div><div class="v">${s.waterTempF != null ? `${s.waterTempF}°F` : '—'}</div>
      <div class="s">${s.waterTempF != null ? 'from gauge' : 'no sensor here. Enter yours below or I\'ll estimate'}</div></div>`;
  if (wx) {
    h += `<div class="stat"><div class="k">Weather</div><div class="v">${wx.airF}°F</div><div class="s">${esc(codeText(wx.code))} · ${wx.cloud}% cloud</div></div>
      <div class="stat"><div class="k">Wind · Pressure</div><div class="v">${wx.windMph}<span class="small"> mph</span></div><div class="s">gusts ${wx.gustMph} · barometer ${wx.pressureTrend}</div></div>
      <div class="stat"><div class="k">Sun</div><div class="s" style="font-size:16px;color:var(--ink)">↑ ${fmtTime(sun.sunrise)}<br>↓ ${fmtTime(sun.sunset)}</div></div>
      <div class="stat"><div class="k">Moon</div><div class="s" style="font-size:16px;color:var(--ink)">${moonPhase()}</div></div>`;
  }
  h += `</div>`;
  const foot = [fl ? `Normal today ${Math.round(fl.p25)}–${Math.round(fl.p75)} cfs` : '', wx ? `weather ${ago(wx.fetchedAt)}` : ''].filter(Boolean).join(' · ');
  if (foot) h += `<p class="small muted" style="margin:8px 0 0">${foot}</p>`;
  return h + `</div>`;
}

function viewManual() {
  const i = S.inputs;
  return `<div class="card"><h2>River conditions (manual)</h2>
    <label class="field">Flow compared with normal</label>${chips('flowBand', [['very low', 'Very low'], ['low', 'Low'], ['normal', 'Normal'], ['high', 'High'], ['very high', 'Very high'], ['unknown', "Don't know"]], i.flowBand)}
    <label class="field">Flow trend</label>${chips('trend', [['rising', 'Rising'], ['steady', 'Steady'], ['falling', 'Dropping']], i.trend)}
    <label class="field">Sky</label>${chips('sky', [['sun', 'Sunny'], ['cloudy', 'Overcast'], ['rain', 'Rain / drizzle']], i.sky)}
    <label class="field">Wind</label>${chips('wind', [['calm', 'Calm'], ['breezy', 'Breezy'], ['windy', 'Windy']], i.wind)}
    <label class="field">Barometer</label>${chips('pressure', [['falling', 'Falling (storm coming)'], ['steady', 'Steady'], ['rising', 'Rising (after front)']], i.pressure)}
    <p class="small muted" style="margin:0">Enter the water temp below if you can. Otherwise I'll estimate from the time of year.</p>
  </div>`;
}

let lastResult = null;

function viewSetups() {
  if (!S.kb) return '<p class="pad muted">Loading…</p>';
  if (!S.site && !S.manual) return `<div class="card"><h2>No river picked yet</h2><p>Go to the <b>River</b> tab, find a gauge near you (or enter conditions), then come back here.</p><button class="btn-primary" data-tab="water">🌊 Pick a river</button></div>`;
  const cond = currentConditions();
  const r = recommend(cond, S.kb, S.gear, S.catches);
  lastResult = r;
  const c = r.cond;
  const tempSrc = cond.tempSource || (c.tempEstimated ? 'estimated' : '');
  const rt = rateConditions(cond, S.kb);
  let h = `<div class="card summary"><div class="site-head"><b>${esc(S.manual ? 'Manual conditions' : S.site.name)}</b>
    <span class="chip-score lvl-${rt.level}" title="Conditions score">${rt.score}</span></div>
    <div class="small">${SPECIES_LABEL[c.species] || 'Trout'} · water ${c.waterTempF}°F (${tempSrc}) · flow ${cond.flowBand || 'unknown'}${c.flowTrend ? ` ${trendArrow(c.flowTrend)}` : ''} · ${CLARITY_LABEL[c.clarity].toLowerCase()} · ${WATER_LABEL[c.waterType].toLowerCase()} ${c.depthFt} ft · ${c.tod}</div>
    ${viewRunAlert()}
    <p style="margin:8px 0 0"><button class="linkish" data-act="toask">💬 Ask Claude about these conditions</button></p></div>`;
  h += viewNudge();
  for (const w of r.warnings) h += `<div class="alert ${w.level}">${w.level === 'stop' ? '🛑 ' : '⚠️ '}${esc(w.text)}</div>`;
  h += readingTheRiver(r.notes, c.river);
  h += viewClaudeAnswers();

  const top = r.setups.slice(0, 3), rest = r.setups.slice(3);
  top.forEach((s, k) => { h += k === 0 ? setupCard(s, 0, false, null, 'best') : compactSetup(s, k); });
  h += fromBoxCard(r.fromBox);
  if (rest.length) h += `<details class="more card"><summary>More options (${rest.length})</summary>${rest.map((s, k) => setupCard(s, k + 3, true)).join('')}</details>`;
  h += viewAskClaude();
  return h;
}

// ---------- Ask Claude (hand-off to the user's own Claude app; no API, no cost) ----------

const CLAUDE_NEW = 'https://claude.ai/new?q=';
const ASK_CHIPS = [
  'Why is this the best setup today?',
  'Fish are rising but refusing my fly. What should I change?',
  'Where on the river should I focus at this flow?',
  'I\'m not getting any takes. What should I try next?',
];
const answerKey = () => `claude:${S.manual ? 'manual' : S.site ? S.site.id : 'none'}`;

function buildPrompt(question) {
  const r = lastResult, c = r.cond, cond = currentConditions();
  const rt = rateConditions(cond, S.kb);
  const lines = [];
  lines.push("I'm fly fishing and using my Fly Buddy app. Here are my current conditions and the app's suggestions.");
  lines.push('');
  lines.push(`My question: ${question || 'What would you fish right now, and how?'}`);
  lines.push('');
  lines.push('CONDITIONS');
  if (S.manual) lines.push('- River: entered by hand (no gauge)');
  else {
    lines.push(`- River: ${S.site.name} (USGS gauge ${S.site.id})`);
    if (S.site.cfs != null) lines.push(`- Flow: ${Math.round(S.site.cfs)} cfs${S.flow ? `, ${S.flow.band} (${S.flow.pct}% of normal for today)` : ''}${S.site.trend ? `, ${S.site.trend}` : ''}`);
  }
  if (S.manual) lines.push(`- Flow: ${cond.flowBand || 'unknown'} compared with normal, ${c.flowTrend || 'trend unknown'}`);
  lines.push(`- Water temp: ${c.waterTempF}°F (${cond.tempSource || 'estimated'})`);
  const wx = S.manual ? null : S.wx;
  if (wx) lines.push(`- Weather: ${wx.airF}°F air, ${codeText(wx.code).toLowerCase()}, ${wx.cloud}% cloud, wind ${wx.windMph} mph, barometer ${wx.pressureTrend}`);
  else if (S.manual) lines.push(`- Weather: ${S.inputs.sky}, ${S.inputs.wind}, barometer ${S.inputs.pressure}`);
  lines.push(`- Date/time: ${new Date().toLocaleString([], { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })} (${c.tod}), region: ${c.region === 'west' ? 'western US' : 'eastern/midwest US'}`);
  lines.push(`- Target: ${c.species || 'trout'}; water clarity: ${c.clarity}; fishing a ${c.waterType} about ${c.depthFt} ft deep`);
  lines.push(`- App's conditions score: ${rt.score}/100 (${rt.label})`);
  if (r.hatches && r.hatches.length) lines.push(`- Likely hatches: ${r.hatches.map((x) => x.h.name).join(', ')}`);
  if (r.warnings.length) lines.push(`- Warnings: ${r.warnings.map((w) => w.text).join(' ')}`);
  lines.push('');
  lines.push("APP'S TOP SETUPS");
  r.setups.slice(0, 3).forEach((s, i) => {
    const rig = s.rig.filter((p) => ['leader', 'tippet', 'indicator', 'shot', 'sinktip'].includes(p.kind)).map((p) => p.label).join('; ');
    lines.push(`${i + 1}. ${s.title}: ${s.rod.text}; ${rig}; flies: ${s.flies.slice(0, 3).map((f) => f.name).join(', ')}`);
  });
  lines.push('');
  const prof = S.manual ? null : riverProfile(S.site);
  const key = S.manual ? null : riverKey(S.site);
  const myNotes = key && S.riverNotes[key];
  if (prof || myNotes) {
    lines.push('RIVER KNOWLEDGE (from my app)');
    if (prof) {
      lines.push(`- Holds: ${(prof.species || []).join(', ')}`);
      for (const run of prof.runs || []) lines.push(`- ${run.label}: ${monthRange(run.months)}${run.peak && run.peak.length ? `, peak ${monthRange(run.peak)}` : ''}`);
      const lib = S.kb.rivers.hatchLibrary || {};
      const hs = (prof.hatches || []).map((x) => (typeof x === 'string' ? lib[x] : x)).filter(Boolean);
      if (hs.length) lines.push(`- Signature hatches: ${hs.map((x) => `${x.name} (${monthRange(x.months)})`).join(', ')}`);
      for (const n of (prof.notes || []).slice(0, 4)) lines.push(`- ${n}`);
      const rep = reportsFor(prof);
      if (rep.items[0]) lines.push(`- Latest local report: ${rep.items[0].source}, ${rep.items[0].date ? rep.items[0].date.slice(0, 10) : ''} "${rep.items[0].title}": ${rep.items[0].excerpt} (${rep.items[0].url})`);
      if (rep.dnr) lines.push(`- Michigan DNR report (${rep.dnr.date.slice(0, 10)}): ${rep.dnr.sections.map((s) => `${s.place}: ${s.text.slice(0, 300)}`).join(' | ')}`);
    }
    if (myNotes) lines.push(`- My own notes: ${myNotes.slice(0, 500)}`);
    lines.push('');
  }
  const seenNow = currentObs();
  if (seenNow) {
    lines.push(`WHAT I'M SEEING ON THE WATER (${ago(seenNow.at)})`);
    lines.push(`- ${obsText(seenNow)}`);
    lines.push('');
  }
  lines.push('MY GEAR');
  lines.push(`- Rods: ${S.gear.rods.length ? S.gear.rods.map((g) => `${g.len}ft ${g.wt}wt ${g.type}`).join(', ') : 'not listed'}`);
  lines.push(`- Fly box: ${S.gear.flies.length ? S.gear.flies.slice(0, 60).join(', ') : 'not listed'}`);
  lines.push('');
  lines.push('Please answer briefly and practically, favouring flies I already carry. At the very end, add this block exactly, filled in, so I can paste it back into my app:');
  lines.push('FLYBUDDY-START');
  lines.push('title: <short name for your recommended setup>');
  lines.push('fly: <pattern and size>  (one line per fly, top to bottom)');
  lines.push('rig: <line / leader / tippet / indicator depth or sink tip>  (one line per item)');
  lines.push('tip: <one short tip>  (up to 3 lines)');
  lines.push('FLYBUDDY-END');
  return lines.join('\n');
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall back */ }
  try {
    const t = document.createElement('textarea');
    t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select(); const ok = document.execCommand('copy'); t.remove(); return ok;
  } catch (e) { return false; }
}

// Pull the FLYBUDDY block out of Claude's reply. Works even if the block got markdown-formatted.
function parseAnswer(text) {
  const clean = text.replace(/\r/g, '');
  const m = /FLYBUDDY-START([\s\S]*?)FLYBUDDY-END/i.exec(clean);
  const out = { title: '', flies: [], rig: [], tips: [], text: clean.replace(/`{3}[a-z]*\n?|`{3}/g, '').trim(), structured: !!m };
  if (m) {
    for (let line of m[1].split('\n')) {
      line = line.replace(/^[\s*\-•`]+|[`*]+$/g, '').trim();
      const kv = /^(title|fly|rig|tip)\s*:\s*(.+)$/i.exec(line);
      if (!kv) continue;
      const k = kv[1].toLowerCase(), v = kv[2].replace(/\*\*/g, '').trim();
      if (k === 'title') out.title = v; else if (k === 'fly') out.flies.push(v); else if (k === 'rig') out.rig.push(v); else out.tips.push(v);
    }
    out.text = clean.slice(0, m.index).replace(/`{3}[a-z]*\n?|`{3}/g, '').trim();
  }
  return out;
}

function viewAskClaude() {
  const q = S.askQ || '';
  return `<details class="card ask" id="ask" ${keep('ask')}><summary><h2 style="margin:0">💬 Ask Claude about this</h2>
    <span class="small muted">Get a second opinion, or ask about what you're seeing</span></summary>
    <p class="small muted">Opens Claude on this phone with today's conditions, the setups above and your gear already filled in. It uses your own Claude account (a free account works), with no cost to the app.</p>
    <div class="chips">${ASK_CHIPS.map((t) => `<button class="chip" data-act="askchip" data-v="${esc(t)}">${esc(t)}</button>`).join('')}</div>
    <textarea id="askq" style="min-height:80px" placeholder="Or type your own question…">${esc(q)}</textarea>
    <p style="margin:10px 0 0"><button class="btn-primary" data-act="ask">Ask Claude ↗</button></p>
    <p class="small" style="margin:8px 0 0"><button class="linkish" data-act="askcopy">Copy for another chatbot</button></p>
    <h3>Got an answer?</h3>
    <p class="small muted" style="margin-top:0">In Claude, tap <b>Copy</b> under the answer, then come back and paste it here. I'll pull out the setup and save it for this river.</p>
    <textarea id="answer" style="min-height:90px" placeholder="Paste Claude's answer here"></textarea>
    <div class="btn-row" style="margin-top:10px"><button data-act="pasteclip">📋 Paste from clipboard</button><button data-act="saveanswer">Save answer</button></div>
  </details>`;
}

function viewClaudeAnswers() {
  const list = S.claudeAnswers || [];
  if (!list.length) return '';
  const card = (a, k) => `<div class="card claude-card">
    <div class="rank">💬 Claude's suggestion · ${ago(a.at)}</div>
    <h2>${esc(a.title || 'Claude\'s advice')}</h2>
    ${a.question ? `<p class="small muted" style="margin:0 0 8px">You asked: ${esc(a.question)}</p>` : ''}
    ${a.flies.length ? `<h3>Flies</h3><ul class="fly-list">${a.flies.map((f) => `<li><span>${ownedFly(f) ? '<span class="own">✓ </span>' : ''}${esc(f)}</span></li>`).join('')}</ul>` : ''}
    ${a.rig.length ? `<h3>Rig</h3><ul class="notes">${a.rig.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${a.tips.length ? `<h3>Tips</h3><ul class="notes">${a.tips.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${a.text ? `<details class="more"><summary>${a.structured ? 'Claude\'s full answer' : 'Claude\'s answer'}</summary><div class="answer-text">${esc(a.text)}</div></details>` : ''}
    <div class="btn-row" style="margin-top:10px">${a.flies.length ? `<button data-act="logclaude" data-k="${k}">🐟 Log a catch on this</button>` : ''}<button class="linkish danger" data-act="delanswer" data-k="${k}">Remove</button></div>
  </div>`;
  let h = card(list[0], 0);
  if (list.length > 1) h += `<details class="more card"><summary>Earlier Claude answers for this river (${list.length - 1})</summary>${list.slice(1).map((a, i) => card(a, i + 1)).join('')}</details>`;
  return h;
}

function ownedFly(name) {
  const key = name.toLowerCase().split(/[#(]/)[0].replace(/\s+\d.*$/, '').trim();
  return S.gear.flies.some((f) => { const b = f.toLowerCase(); return b === key || (b.length >= 5 && (key.includes(b) || b.includes(key))); });
}

async function loadClaudeAnswers() {
  S.claudeAnswers = await store.get(answerKey(), []);
}

async function saveAnswer(text) {
  if (!text || !text.trim()) { toast('Paste Claude\'s answer first.'); return; }
  const a = { ...parseAnswer(text), at: Date.now(), question: S.lastAskQ || '' };
  S.claudeAnswers = [a, ...(S.claudeAnswers || [])].slice(0, 5);
  await store.set(answerKey(), S.claudeAnswers);
  render(); window.scrollTo(0, 0);
  toast(a.structured ? 'Claude\'s setup saved for this river' : 'Saved. (No setup block found, so I kept the full answer.)');
}

// At most 3 headline notes, most useful first; the rest fold away. Profile notes are left out
// (they're on the River tab), and notes saying the same thing appear once.
function readingTheRiver(notes, river) {
  const profileNotes = new Set((river && river.notes) || []);
  const seen = new Set();
  const list = notes.filter((n) => {
    if (profileNotes.has(n)) return false;
    const key = /egg/i.test(n) && /spawn/i.test(n) ? 'eggdrift' : n;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const rank = (n) => (n.startsWith('📰') ? 0 : /run|peak|spawn|season/i.test(n) ? 1 : /likely bugs|hatch/i.test(n) ? 2 : 3);
  list.sort((a, b) => rank(a) - rank(b));
  if (!list.length) return '';
  const top = list.slice(0, 3), rest = list.slice(3);
  return `<div class="card"><h2>Reading the river</h2><ul class="notes">${top.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
    ${rest.length ? `<details class="more" ${keep('morenotes')}><summary>More notes (${rest.length})</summary><ul class="notes">${rest.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>` : ''}</div>`;
}

// 2nd and 3rd choices: title, first reason and key specs; tap to see the full rig.
function compactSetup(s, k) {
  const rank = ['Best bet', '2nd choice', '3rd choice'][k] || 'Option';
  return `<details class="card setup compact" ${keep(`setup-${s.key}`)}>
    <summary><div class="rank">${rank}</div><h2>${esc(s.title)}</h2>
      <p class="spec">${esc(keySpec(s))}</p><p class="small" style="margin:2px 0 0">${esc(s.why[0] || '')}</p>
      <span class="more-link">Show rig, flies and tips</span></summary>
    ${setupCard(s, k, true, '', '', true)}
  </details>`;
}

// One-time hint for new users: add gear so setups can mark what you own.
function viewNudge() {
  if (S.nudgeDismissed || S.gear.rods.length || S.gear.flies.length) return '';
  return `<div class="card nudge"><b>Tip:</b> add your rods and flies on the <b>Gear</b> tab. Setups will then use your rods, mark flies you own with ✓ and build a setup from your own box.
    <div class="btn-row" style="margin-top:8px"><button data-tab="gear">🧰 Go to Gear</button><button class="linkish" data-act="dismissnudge">Not now</button></div></div>`;
}

function fromBoxCard(fb) {
  if (!fb) return '';
  const head = '<div class="rank">🧰 From your fly box</div>';
  if (fb.status === 'ok') return setupCard(fb.setup, -1, false, head, 'boxsetup');
  const msg = {
    topOwned: '<b>Good news:</b> the Best bet above uses flies you already carry.',
    empty: 'Tick the flies you carry on the <b>Gear</b> tab and I\'ll build a setup from your own box.',
    nomatch: 'None of the flies in your box suit today\'s setups. Worth picking up some of the flies listed above.',
  }[fb.status];
  return `<div class="card boxsetup">${head}<p style="margin:6px 0 0">${msg}</p>
    ${fb.status === 'empty' ? '<p style="margin:10px 0 0"><button style="width:100%" data-tab="gear">🧰 Go to my fly box</button></p>' : ''}</div>`;
}

function setupCard(s, k, inner, rankHtml, extraClass = '', noHead = false) {
  const rank = ['Best bet', '2nd choice', '3rd choice'][k] || 'Option';
  const head = noHead ? '' : `${rankHtml || `<div class="rank">${rank}</div>`}<h2>${esc(s.title)}</h2>`;
  return `<div class="${inner ? '' : 'card '}setup ${extraClass}">${head}
    <ul class="why">${s.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
    <dl class="kv"><dt>Rod</dt><dd>${esc(s.rod.text)}${s.rod.note ? `<br><span class="small muted">${esc(s.rod.note)}</span>` : ''}</dd>
    <dt>Line</dt><dd>${esc(s.line)}</dd></dl>
    <h3>Rig, top to bottom</h3>${rigDiagram(s.rig)}
    <h3>Flies</h3><ul class="fly-list">${s.flies.map((f) => `<li><span>${f.owned ? '<span class="own">✓ </span>' : ''}${esc(f.name)}</span><span class="role">${esc(f.role)}</span></li>`).join('')}</ul>
    ${s.flies.some((f) => f.owned) ? '<p class="small muted" style="margin:0 0 6px">✓ = in your fly box</p>' : ''}
    <details class="more tips" ${keep(`tips-${s.key}-${extraClass}`)}><summary>Tips (${s.tips.length})</summary><ul class="notes">${s.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></details>
    <p style="margin:12px 0 0"><button style="width:100%" data-act="quicklog" data-key="${s.key}"${extraClass === 'boxsetup' ? ' data-box="1"' : ''}>🐟 Caught one on this</button></p>
  </div>`;
}

const GLYPH = {
  indicator: '<svg width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="11" fill="#f97316" stroke="#7c2d12" stroke-width="2"/><circle cx="16" cy="16" r="4" fill="#fff"/></svg>',
  shot: '<svg width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="11" r="5" fill="#6b7280"/><circle cx="16" cy="22" r="5" fill="#6b7280"/></svg>',
  fly: '<svg width="32" height="32" viewBox="0 0 32 32"><path d="M16 4 V20 a6 6 0 0 1 -12 0" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><ellipse cx="16" cy="12" rx="5" ry="8" fill="#a16207"/><circle cx="16" cy="5" r="3" fill="#d4a017"/></svg>',
  sighter: '',
};

function rigDiagram(parts) {
  return `<div class="rig">${parts.map((p) => `<div class="rig-row k-${p.kind}"><div class="rig-ico">${GLYPH[p.kind] || ''}</div>
    <div class="rig-txt"><b>${esc(p.label)}</b>${p.detail ? `<span>${esc(p.detail)}</span>` : ''}</div></div>`).join('')}</div>`;
}

// ---------- Log ----------

const TECH = [['dry', 'Dry fly'], ['drydropper', 'Dry-dropper'], ['nymph', 'Indicator nymph'], ['euro', 'Euro nymph'], ['streamer', 'Streamer'], ['softhackle', 'Soft hackle'], ['swing', 'Swing'], ['skate', 'Skated dry'], ['shnymph', 'Egg / nymph (steelhead)'], ['salegg', 'Egg rig (salmon)'], ['salstreamer', 'Streamer (salmon)']];
const techName = (k) => (TECH.find((t) => t[0] === k) || [k, k])[1];

function viewLog() {
  let h = '';
  const d = S.logDraft;
  if (d) {
    h += `<div class="card"><h2>Log a catch</h2>
      <label class="field">Species</label>${chips('log.species', [['trout', 'Trout'], ['steelhead', 'Steelhead'], ['salmon', 'Salmon']], d.species)}
      <label class="field">Technique</label><select data-log="technique">${TECH.map(([k, l]) => `<option value="${k}" ${d.technique === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <label class="field">Fly</label><input type="text" list="flyopts" data-log="fly" value="${esc(d.fly)}" placeholder="e.g. Pheasant Tail #16">
      <datalist id="flyopts">${(d.flyOptions || []).map((f) => `<option value="${esc(f)}">`).join('')}</datalist>
      <label class="field">Length (inches, optional)</label><input type="number" inputmode="decimal" data-log="length" value="${esc(d.length)}">
      <label class="field">Notes</label><input type="text" data-log="notes" value="${esc(d.notes)}" placeholder="where, what happened">
      <label class="field">Photo (optional)</label><input type="file" accept="image/*" capture="environment" data-act="photo">
      ${d.photo ? `<img src="${d.photo}" alt="" style="width:100%;border-radius:12px;margin-top:8px">` : ''}
      <p class="small muted">Conditions saved with it: ${esc(condSummary(d.cond))}</p>
      <div class="btn-row"><button class="btn-primary" data-act="savelog">Save catch</button><button data-act="cancellog">Cancel</button></div></div>`;
  } else {
    h += `<div class="card"><button class="btn-primary" data-act="newlog">+ Log a catch</button>
      <p class="small muted" style="margin:8px 0 0">Your catches teach the app. Setups that worked for you in similar conditions get ranked higher next time.</p></div>`;
  }
  if (S.catches.length) {
    h += `<div class="card"><h2>${S.catches.length} catch${S.catches.length === 1 ? '' : 'es'}</h2>`;
    for (const [k, c] of [...S.catches.entries()].reverse()) {
      h += `<div class="log-item" style="border-top:1px solid var(--line);padding:10px 0">${c.photo ? `<img src="${c.photo}" alt="">` : ''}
        <div style="flex:1"><div class="t">${esc(c.fly || 'Unknown fly')}${c.length ? ` · ${esc(c.length)}"` : ''}</div>
        <div class="small">${esc(techName(c.technique))} · ${SPECIES_LABEL[c.species] || 'Trout'} · ${new Date(c.date).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</div>
        <div class="small muted">${esc(condSummary(c.cond))}${c.notes ? `<br>${esc(c.notes)}` : ''}</div>
        <button class="linkish small danger" data-act="dellog" data-k="${k}">Delete</button></div></div>`;
    }
    h += `</div>`;
  }
  h += `<div class="card"><h2>Backup</h2><p class="small muted">Your log and gear live only on this phone. Save a backup file now and then.</p>
    <div class="btn-row"><button data-act="export">⬇️ Save backup</button><label class="btn" style="text-align:center">⬆️ Restore<input type="file" accept="application/json" data-act="import" hidden></label></div></div>`;
  return h;
}

function condSummary(c) {
  if (!c) return '';
  return [c.site, c.waterTempF != null ? `${c.waterTempF}°F water` : '', c.cfs != null ? `${Math.round(c.cfs)} cfs` : '', c.flowBand, c.clarity].filter(Boolean).join(' · ');
}

function startLog(key, fromBox) {
  S.logDraft = makeLogDraft(key, fromBox);
  S.tab = 'log'; render(); window.scrollTo(0, 0);
}

// "Caught one on this": save straight away with the setup's first fly and current conditions.
async function quickLog(key, fromBox) {
  const d = makeLogDraft(key, fromBox);
  S.catches.push({ date: Date.now(), species: d.species, technique: d.technique, fly: d.fly, length: '', notes: '', photo: null, cond: d.cond });
  await store.set('catches', S.catches);
  const idx = S.catches.length - 1;
  toast(`Catch saved 🐟 ${d.fly || ''}`, {
    label: 'Add details',
    fn: () => { S.logDraft = { ...d, editIndex: idx }; S.tab = 'log'; render(); window.scrollTo(0, 0); },
  });
}

function makeLogDraft(key, fromBox) {
  const cond = S.site || S.manual ? currentConditions() : null;
  const res = lastResult;
  const setup = !res || !key ? null
    : fromBox && res.fromBox && res.fromBox.setup ? res.fromBox.setup
      : res.setups.find((s) => s.key === key);
  return {
    species: S.inputs.species, technique: key || ({ steelhead: 'swing', salmon: 'salegg' }[S.inputs.species] || 'nymph'),
    fly: setup ? setup.flies[0].name.replace(/^(Tag|Point):\s*/, '') : '', length: '', notes: '', photo: null,
    flyOptions: res ? [...new Set(res.setups.flatMap((s) => s.flies.map((f) => f.name)))] : [],
    cond: cond ? {
      site: S.manual ? 'manual' : S.site.name, waterTempF: res ? res.cond.waterTempF : cond.waterTempF,
      cfs: S.manual ? null : S.site.cfs, flowBand: cond.flowBand, clarity: cond.clarity, waterType: cond.waterType,
      depthFt: cond.depthFt, month: new Date().getMonth() + 1,
    } : null,
  };
}

function resizePhoto(file, maxPx = 900, quality = 0.72) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxPx / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(img.src);
      res(cv.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => res(null);
    img.src = URL.createObjectURL(file);
  });
}

// ---------- Gear ----------

// Base pattern name: "Zebra Midge (black/red) #18-22" -> "Zebra Midge". This is also how setups match your box.
const flyBase = (n) => n.split(/[#(]/)[0].replace(/\s+\d[\d.\-]*\s*(in|mm)?\s*\+?$/i, '').trim();

// Every pattern the app can recommend, grouped. Built from /knowledge so it stays in sync.
let catalogCache = null;
function flyCatalog() {
  if (catalogCache) return catalogCache;
  const kb = S.kb, seen = new Set();
  const groups = [['Dry flies', []], ['Emergers & soft hackles', []], ['Nymphs, worms & eggs', []], ['Streamers', []], ['Steelhead & salmon', []]];
  const add = (gi, names) => {
    for (const n of names) {
      const b = flyBase(n), k = b.toLowerCase();
      if (b && !seen.has(k)) { seen.add(k); groups[gi][1].push(b); }
    }
  };
  const hs = kb.hatches.hatches;
  // Order matters: a pattern listed in several places goes in the first group that claims it.
  add(0, hs.flatMap((h) => h.dry)); add(0, kb.flies.attractor_dries);
  add(2, hs.flatMap((h) => h.nymph)); add(2, Object.values(kb.flies.nymphs).flat()); add(2, kb.flies.winter_nymphs);
  add(2, ['Perdigon', "Walt's Worm"]); // euro nymphing staples used by the engine
  add(3, Object.values(kb.flies.streamers).flat());
  add(1, hs.flatMap((h) => h.emerger)); add(1, kb.flies.soft_hackles);
  const sh = kb.steelhead;
  add(4, Object.values(sh.swing_flies).flatMap((x) => x.patterns)); add(4, sh.skaters); add(4, Object.values(sh.nymph_flies).flat());
  add(4, Object.values(kb.salmon.streamers).flat()); add(4, Object.values(kb.salmon.eggs).flat()); add(4, kb.salmon.coho);
  const lib = kb.rivers.hatchLibrary || {};
  for (const h of Object.values(lib)) { add(0, h.dry); add(2, h.nymph); add(1, h.emerger); }
  for (const g of groups) g[1].sort((a, b) => a.localeCompare(b));
  catalogCache = groups;
  return groups;
}
const catalogSet = () => new Set(flyCatalog().flatMap((g) => g[1]).map((n) => n.toLowerCase()));

function viewGear() {
  const g = S.gear;
  return `<div class="card"><h2>My rods</h2>
    <p class="small muted" style="margin-top:0">Setups will use the rod you own that fits best.</p>
    ${g.rods.length ? g.rods.map((r, k) => `<div class="rod-row"><span><b>${r.len} ft ${r.wt}wt</b> ${r.type !== 'single' ? r.type : 'single-hand'}</span><button class="linkish danger" data-act="delrod" data-k="${k}">Remove</button></div>`).join('') : '<p class="muted">No rods yet.</p>'}
    <h3>Add a rod</h3>
    <div class="grid3">
      <select id="rwt">${[2, 3, 4, 5, 6, 7, 8, 9, 10].map((w) => `<option value="${w}" ${w === 5 ? 'selected' : ''}>${w}wt</option>`).join('')}</select>
      <select id="rlen">${[7.5, 8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14].map((l) => `<option value="${l}" ${l === 9 ? 'selected' : ''}>${l} ft</option>`).join('')}</select>
      <select id="rtype"><option value="single">Single-hand</option><option value="euro">Euro nymph</option><option value="switch">Switch</option><option value="spey">Spey</option></select>
    </div>
    <p style="margin:10px 0 0"><button style="width:100%" data-act="addrod">+ Add rod</button></p></div>
  <div class="card"><h2>Minimum score to fish</h2>
    <p class="small muted" style="margin-top:0">Rivers and days scoring below this get flagged as probably not worth the trip.</p>
    <label class="field">Minimum: <span id="minv">${minScore()}</span> / 100</label>
    <input type="range" min="0" max="100" step="5" value="${minScore()}" data-gear="minScore">
    <p class="small muted" style="margin:4px 0 0">${S.kb.rating.labels.map((l) => `${l.min}+ ${l.label}`).join(' · ')}</p></div>
  ${viewFlyBox()}
  ${viewBoxPhotos()}
  <div class="card small muted">Fly Buddy uses free public data: USGS river gauges and Open-Meteo weather. All advice comes from built-in rules, with no paid services. Your data stays on this phone.<br><br>App version ${APP_VERSION}</div>`;
}

function viewFlyBox() {
  const owned = new Set(S.gear.flies.map((f) => f.toLowerCase()));
  const known = catalogSet();
  const others = S.gear.flies.filter((f) => !known.has(f.toLowerCase()));
  const groups = flyCatalog();
  const ticked = groups.reduce((n, g) => n + g[1].filter((f) => owned.has(f.toLowerCase())).length, 0);
  return `<div class="card"><h2>My fly box</h2>
    <p class="small muted" style="margin-top:0">Tap the patterns you carry. Setups mark them ✓ so you know what you already have. Sizes and colors don't matter here.</p>
    <p style="margin:0 0 6px"><b id="flycount">${ticked}</b> patterns ticked</p>
    ${groups.map(([name, flies]) => {
      const n = flies.filter((f) => owned.has(f.toLowerCase())).length;
      return `<details class="flygroup"><summary>${esc(name)} <span class="muted small">(<span data-gcount>${n}</span> of ${flies.length})</span></summary>
        <div class="chips">${flies.map((f) => `<button class="chip ${owned.has(f.toLowerCase()) ? 'on' : ''}" data-act="flytoggle" data-v="${esc(f)}">${esc(f)}</button>`).join('')}</div></details>`;
    }).join('')}
    <h3>Other flies (not in the list)</h3>
    <p class="small muted" style="margin-top:0">One per line. Useful for your own patterns.</p>
    <textarea id="flybox" style="min-height:90px">${esc(others.join('\n'))}</textarea>
    <p style="margin:10px 0 0"><button style="width:100%" data-act="saveflies">Save other flies</button></p></div>`;
}

function viewBoxPhotos() {
  const ph = S.boxPhotos;
  return `<div class="card"><h2>Fly box photos</h2>
    <p class="small muted" style="margin-top:0">Snap each box so you can check what's in it on the water. Tap a photo to see it full size. Pinch to zoom.</p>
    ${ph.length ? `<div class="photo-grid">${ph.map((p, k) => `<figure><button class="thumb" data-act="viewphoto" data-k="${k}"><img src="${p.photo}" alt="${esc(p.label)}"></button>
      <figcaption><input type="text" value="${esc(p.label)}" data-boxlabel="${k}" aria-label="Photo name"><button class="linkish danger small" data-act="delphoto" data-k="${k}">Delete</button></figcaption></figure>`).join('')}</div>` : ''}
    <label class="btn" style="display:block;text-align:center;margin-top:10px">📷 Add a fly box photo<input type="file" accept="image/*" data-act="boxphoto" hidden></label></div>`;
}

function showPhoto(src) {
  const o = document.createElement('div');
  o.className = 'viewer';
  o.innerHTML = `<button class="viewer-x" aria-label="Close">✕ Close</button><img src="${src}" alt="">`;
  o.addEventListener('click', (e) => { if (e.target.closest('.viewer-x') || e.target === o) o.remove(); });
  document.body.appendChild(o);
}

// ---------- events ----------

document.getElementById('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  S.tab = b.dataset.tab; render(); window.scrollTo(0, 0);
});

$app.addEventListener('click', async (e) => {
  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) { S.tab = tabBtn.dataset.tab; render(); return; }
  const b = e.target.closest('[data-act]');
  if (!b || b.type === 'file') return;
  const act = b.dataset.act;
  if (act === 'near') findNearMe();
  else if (act === 'manual') {
    S.picking = false; S.manual = true; S.site = null; S.wx = null; S.flow = null; saveSession();
    await loadClaudeAnswers(); render(); window.scrollTo(0, 0);
    if (navigator.onLine) manualWeatherFromGps();
  }
  else if (act === 'pick' || act === 'fav') {
    // Switch straight to the "chosen" view so the tap is obviously registered.
    S.picking = false; window.scrollTo(0, 0);
    selectSite((act === 'pick' ? S.nearby : S.favorites)[+b.dataset.k]);
  }
  else if (act === 'change') { S.picking = true; S.query = ''; render(); window.scrollTo(0, 0); updateFavScores(); }
  else if (act === 'back') { S.picking = false; render(); window.scrollTo(0, 0); }
  else if (act === 'clearq') { S.query = ''; S.nearby = null; S.nearbyTitle = ''; render(); document.getElementById('q').focus(); }
  else if (act === 'star') {
    const s = S.site, i = S.favorites.findIndex((f) => f.id === s.id);
    if (i >= 0) S.favorites.splice(i, 1); else S.favorites.push({ id: s.id, name: s.name, lat: s.lat, lon: s.lon });
    await store.set('favorites', S.favorites); render();
    toast(i >= 0 ? 'Removed from saved rivers' : 'Saved. Use "Download for offline" before you lose signal.');
    updateFavScores();
  }
  else if (act === 'prep') tripPrep();
  else if (act === 'set') {
    const f = b.dataset.f, v = b.dataset.v;
    if (f.startsWith('log.')) S.logDraft[f.slice(4)] = v; else { S.inputs[f] = v; saveSession(); }
    const y = window.scrollY; render(); window.scrollTo(0, y);
  }
  else if (act === 'go') { S.tab = 'setups'; render(); window.scrollTo(0, 0); }
  else if (act === 'logthis') startLog(b.dataset.key, !!b.dataset.box);
  else if (act === 'toask') {
    const el = document.getElementById('ask');
    S.openState.ask = true; el.open = true;
    el.scrollIntoView({ behavior: 'smooth' });
  }
  else if (act === 'quicklog') quickLog(b.dataset.key, !!b.dataset.box);
  else if (act === 'obs') {
    await toggleObs(b.dataset.g, b.dataset.v);
    const y = window.scrollY; render(); window.scrollTo(0, y);
  }
  else if (act === 'obsclear') {
    delete S.observed[obsKey()];
    await store.set('observed', S.observed);
    const y = window.scrollY; render(); window.scrollTo(0, y);
  }
  else if (act === 'dismissnudge') { S.nudgeDismissed = true; store.set('nudgeDismissed', true); render(); }
  else if (act === 'buildprofile') {
    const prompt = buildProfilePrompt(S.site);
    copyText(prompt);
    window.open(CLAUDE_NEW + encodeURIComponent(prompt), '_blank');
    S.profileOpen = true;
    toast('Opening Claude… When it answers, copy the whole reply and paste it under "Paste Claude\'s profile".');
    const y = window.scrollY; render(); window.scrollTo(0, y);
  }
  else if (act === 'profclip') {
    try {
      const t = await navigator.clipboard.readText();
      document.getElementById('profpaste').value = t;
      saveProfileText(t);
    } catch (e) { toast('Long-press the box and choose Paste, then tap Save profile.'); }
  }
  else if (act === 'saveprofile') saveProfileText(document.getElementById('profpaste').value);
  else if (act === 'shareprofile') {
    const p = { ...riverProfile(S.site) };
    delete p.local;
    const ok = await copyText(JSON.stringify(p, null, 2));
    toast(ok ? 'Copied. On GitHub, paste it into knowledge/rivers.json inside the "rivers" list (add a comma between entries).' : 'Could not copy on this phone.');
  }
  else if (act === 'delprofile') {
    if (!confirm('Remove the profile saved on this phone for this river?')) return;
    delete S.profiles[riverKey(S.site)];
    await store.set('profiles', S.profiles); render();
  }
  else if (act === 'askchip') { const t = document.getElementById('askq'); t.value = b.dataset.v; S.askQ = b.dataset.v; }
  else if (act === 'ask' || act === 'askcopy') {
    const q = document.getElementById('askq').value.trim();
    S.lastAskQ = q;
    const prompt = buildPrompt(q);
    // Start both inside the tap so the phone allows them: copy (fallback) and open Claude.
    const copied = copyText(prompt);
    if (act === 'ask') {
      const url = CLAUDE_NEW + encodeURIComponent(prompt);
      window.open(url.length < 12000 ? url : 'https://claude.ai/new', '_blank');
      toast('Opening Claude… The details are also copied. If the message box is empty, paste them in.');
    } else {
      toast((await copied) ? 'Copied. Paste it into any chatbot.' : 'Could not copy on this phone.');
    }
  }
  else if (act === 'pasteclip') {
    try {
      const t = await navigator.clipboard.readText();
      document.getElementById('answer').value = t;
      if (t.trim()) saveAnswer(t); else toast('The clipboard is empty. Copy Claude\'s answer first.');
    } catch (e) { toast('Long-press the box and choose Paste, then tap Save answer.'); }
  }
  else if (act === 'saveanswer') saveAnswer(document.getElementById('answer').value);
  else if (act === 'delanswer') {
    S.claudeAnswers.splice(+b.dataset.k, 1);
    await store.set(answerKey(), S.claudeAnswers); render();
  }
  else if (act === 'logclaude') {
    const a = S.claudeAnswers[+b.dataset.k];
    startLog(null);
    S.logDraft.fly = a.flies[0];
    S.logDraft.flyOptions = [...new Set([...a.flies, ...S.logDraft.flyOptions])];
    render();
  }
  else if (act === 'newlog') startLog(null);
  else if (act === 'cancellog') { S.logDraft = null; render(); }
  else if (act === 'savelog') {
    const d = S.logDraft;
    const entry = { species: d.species, technique: d.technique, fly: d.fly.trim(), length: d.length, notes: d.notes, photo: d.photo, cond: d.cond };
    // Editing a quick-logged catch keeps its original time.
    if (d.editIndex != null && S.catches[d.editIndex]) S.catches[d.editIndex] = { ...S.catches[d.editIndex], ...entry };
    else S.catches.push({ date: Date.now(), ...entry });
    await store.set('catches', S.catches);
    S.logDraft = null; render(); toast('Catch saved 🐟');
  }
  else if (act === 'dellog') {
    if (!confirm('Delete this catch?')) return;
    S.catches.splice(+b.dataset.k, 1); await store.set('catches', S.catches); render();
  }
  else if (act === 'addrod') {
    S.gear.rods.push({ wt: +document.getElementById('rwt').value, len: +document.getElementById('rlen').value, type: document.getElementById('rtype').value });
    await store.set('gear', S.gear); render(); toast('Rod added');
  }
  else if (act === 'delrod') { S.gear.rods.splice(+b.dataset.k, 1); await store.set('gear', S.gear); render(); }
  else if (act === 'flytoggle') {
    // Toggle in place (no re-render) so the open section stays open.
    const name = b.dataset.v, k = name.toLowerCase();
    const i = S.gear.flies.findIndex((f) => f.toLowerCase() === k);
    if (i >= 0) S.gear.flies.splice(i, 1); else S.gear.flies.push(name);
    b.classList.toggle('on', i < 0);
    const grp = b.closest('details');
    grp.querySelector('[data-gcount]').textContent = grp.querySelectorAll('.chip.on').length;
    document.getElementById('flycount').textContent = document.querySelectorAll('.flygroup .chip.on').length;
    await store.set('gear', S.gear);
  }
  else if (act === 'saveflies') {
    const known = catalogSet();
    const ticked = S.gear.flies.filter((f) => known.has(f.toLowerCase()));
    const others = document.getElementById('flybox').value.split('\n').map((x) => x.trim()).filter(Boolean);
    S.gear.flies = [...ticked, ...others];
    await store.set('gear', S.gear); toast('Saved');
  }
  else if (act === 'viewphoto') showPhoto(S.boxPhotos[+b.dataset.k].photo);
  else if (act === 'delphoto') {
    if (!confirm('Delete this photo?')) return;
    S.boxPhotos.splice(+b.dataset.k, 1); await store.set('boxPhotos', S.boxPhotos); render();
  }
  else if (act === 'export') {
    const blob = new Blob([JSON.stringify({ app: 'fly-buddy', v: 1, gear: S.gear, catches: S.catches, favorites: S.favorites, boxPhotos: S.boxPhotos }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `fly-buddy-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
});

// Remember open/closed sections (the toggle event doesn't bubble, so listen in the capture phase).
$app.addEventListener('toggle', (e) => {
  const k = e.target.dataset && e.target.dataset.keep;
  if (k) S.openState[k] = e.target.open;
}, true);

$app.addEventListener('submit', (e) => {
  if (e.target.dataset.act !== 'search') return;
  e.preventDefault();
  const q = document.getElementById('q');
  q.blur(); // close the phone keyboard
  searchRivers(q.value);
});

$app.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.in) {
    S.inputs[el.dataset.in] = el.value;
    if (el.dataset.in === 'depthFt') { const dv = document.getElementById('dv'); if (dv) dv.textContent = el.value; }
    saveSession();
  } else if (el.dataset.log) {
    S.logDraft[el.dataset.log] = el.value;
  } else if (el.dataset.rivernotes !== undefined) {
    S.riverNotes[el.dataset.rivernotes] = el.value;
    store.set('rivernotes', S.riverNotes);
  } else if (el.id === 'askq') {
    S.askQ = el.value;
  } else if (el.dataset.gear === 'minScore') {
    S.gear.minScore = +el.value;
    document.getElementById('minv').textContent = el.value;
    store.set('gear', S.gear);
  } else if (el.dataset.boxlabel) {
    S.boxPhotos[+el.dataset.boxlabel].label = el.value;
    store.set('boxPhotos', S.boxPhotos);
  }
});

$app.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.log) S.logDraft[el.dataset.log] = el.value;
  if (el.dataset.act === 'photo' && el.files[0]) {
    S.logDraft.photo = await resizePhoto(el.files[0]); render();
  }
  if (el.dataset.act === 'boxphoto' && el.files[0]) {
    // Keep box photos sharper than catch photos so small flies are readable when zoomed.
    const photo = await resizePhoto(el.files[0], 1600, 0.8);
    if (!photo) { toast('Could not read that photo.'); return; }
    S.boxPhotos.push({ photo, label: `Box ${S.boxPhotos.length + 1}`, date: Date.now() });
    await store.set('boxPhotos', S.boxPhotos); render(); toast('Photo saved');
  }
  // The score depends on the thermometer reading; refresh once the user finishes typing.
  if (el.dataset.in === 'tempOverride') { const y = window.scrollY; render(); window.scrollTo(0, y); }
  if (el.dataset.act === 'import' && el.files[0]) {
    try {
      const j = JSON.parse(await el.files[0].text());
      if (j.app !== 'fly-buddy') throw new Error();
      if (!confirm(`Restore ${j.catches.length} catches, ${j.gear.rods.length} rods and ${j.favorites.length} rivers? This replaces what's on this phone.`)) return;
      S.gear = j.gear; S.catches = j.catches; S.favorites = j.favorites;
      if (j.boxPhotos) S.boxPhotos = j.boxPhotos;
      await Promise.all([store.set('gear', S.gear), store.set('catches', S.catches), store.set('favorites', S.favorites), store.set('boxPhotos', S.boxPhotos)]);
      render(); toast('Backup restored');
    } catch (err) { toast('That file is not a Fly Buddy backup.'); }
  }
});

// In manual mode we can still grab real weather if there's signal.
async function manualWeatherFromGps() {
  try {
    S.gps = S.gps || await gps();
    S.wx = await getWeather(S.gps.lat, S.gps.lon);
    store.set('wx:gps', S.wx);
  } catch (e) { S.wx = await store.get('wx:gps'); }
  // Only sunrise/sunset are used in manual mode; sky/wind come from the chips.
  render();
}

window.addEventListener('online', render);
window.addEventListener('offline', render);

// ---------- start ----------

(async function init() {
  store.persist();
  const h = location.hash.slice(1);
  if (['water', 'setups', 'log', 'gear'].includes(h)) S.tab = h;
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try { S.kb = await loadKB(); } catch (e) { $app.innerHTML = '<p class="pad">Could not load the app data. Open it once with signal so it can save itself for offline use.</p>'; return; }
  S.gear = await store.get('gear', { rods: [], flies: [] });
  S.catches = await store.get('catches', []);
  S.favorites = await store.get('favorites', []);
  S.boxPhotos = await store.get('boxPhotos', []);
  S.profiles = await store.get('profiles', {});
  S.riverNotes = await store.get('rivernotes', {});
  S.nudgeDismissed = await store.get('nudgeDismissed', false);
  S.observed = await store.get('observed', {});
  S.reports = await store.get('reports');
  loadReports().then(() => { if (S.tab === 'water' && !isPicking()) render(); });
  S.prep = await store.get('prepMsg', '');
  const sess = await store.get('session');
  if (sess) {
    S.hadSession = true;
    S.inputs = { ...DEFAULT_INPUTS, ...sess.inputs };
    S.manual = !!sess.manual;
    if (sess.site) { selectSite(sess.site); updateFavScores(); return; }
    if (S.manual) { S.wx = await store.get('wx:gps'); await loadClaudeAnswers(); }
  }
  render();
  updateFavScores();
})();
