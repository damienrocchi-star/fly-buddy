// Fly Buddy: screens, state and glue. No build step, no API keys.
import * as store from './store.js';
import { findNearby, searchByName, getSite, getFlowStats, flowBand, distanceMi } from './data/usgs.js';
import { getWeather, sunFor, moonPhase, codeText } from './data/weather.js';
import { recommend, regionFor } from './engine/recommend.js';

const APP_VERSION = '5'; // keep in step with CACHE in sw.js
const $app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DEFAULT_INPUTS = {
  species: 'trout', clarity: 'clear', waterType: 'run', depthFt: 3, tempOverride: '',
  // manual mode only
  flowBand: 'normal', trend: 'steady', sky: 'cloudy', wind: 'breezy', pressure: 'steady',
};

const S = {
  tab: 'water', picking: false, kb: null, gear: { rods: [], flies: [] }, catches: [], favorites: [], boxPhotos: [],
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

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
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
  const [hatches, flies, steelhead] = await Promise.all(
    ['hatches', 'flies', 'steelhead'].map((n) => fetch(`knowledge/${n}.json`).then((r) => r.json())));
  return { hatches, flies, steelhead };
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
  S.loading = '';
  saveSession();
  render();
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
  const i = S.inputs;
  const override = i.tempOverride !== '' && !isNaN(+i.tempOverride) ? Math.round(+i.tempOverride) : null;
  const site = S.manual ? null : S.site;
  let waterTempF = override, tempSource = override != null ? 'your reading' : null;
  if (waterTempF == null && site && site.waterTempF != null) { waterTempF = site.waterTempF; tempSource = 'gauge'; }
  const sun = sunFor(S.wx);
  const lon = site ? site.lon : S.gps ? S.gps.lon : null;
  return {
    species: i.species, clarity: i.clarity, waterType: i.waterType, depthFt: +i.depthFt,
    waterTempF, tempSource,
    flowBand: S.manual ? (i.flowBand === 'unknown' ? null : i.flowBand) : S.flow && S.flow.band,
    flowTrend: S.manual ? i.trend : site && site.trend,
    weather: S.manual || !S.wx ? (S.manual ? manualWeather() : null) : S.wx,
    sunrise: sun.sunrise, sunset: sun.sunset,
    region: regionFor(lon),
    now: new Date(),
  };
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
    h += `<h3>★ Saved rivers</h3><ul class="site-list">${S.favorites.map((f, k) =>
      `<li><button data-act="fav" data-k="${k}"><span class="nm">${esc(f.name)}</span><span class="meta">›</span></button></li>`).join('')}</ul>
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

function viewChosen() {
  const i = S.inputs;
  let h = viewSelectedBar();
  if (S.manual) h += viewManual();
  else if (!S.loading) h += viewConditions();
  {
    h += `<div class="card"><h2>Your spot</h2>
      <label class="field">Fishing for</label>${chips('species', [['trout', 'Trout'], ['steelhead', 'Steelhead / Salmon']], i.species)}
      <label class="field">Water clarity</label>${chips('clarity', [['clear', 'Clear'], ['slight', 'Slight tint'], ['stained', 'Stained'], ['muddy', 'Muddy']], i.clarity)}
      <label class="field">Type of water</label>${chips('waterType', [['riffle', 'Riffle'], ['run', 'Run'], ['pool', 'Pool'], ['pocket', 'Pocket water'], ['flat', 'Flat / glide']], i.waterType)}
      <label class="field">Depth where fish hold: <span id="dv">${i.depthFt}</span> ft</label>
      <input type="range" min="1" max="10" step="0.5" value="${i.depthFt}" data-in="depthFt">
      <label class="field">Water temp from your thermometer (°F, optional)</label>
      <input type="number" inputmode="decimal" placeholder="${S.site && S.site.waterTempF != null && !S.manual ? `gauge says ${S.site.waterTempF}°F` : 'e.g. 52'}" value="${esc(i.tempOverride)}" data-in="tempOverride">
      <p style="margin:14px 0 0"><button class="btn-primary" data-act="go">🎣 Show me what to fish</button></p>
    </div>`;
  }
  return h;
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
  if (fl) h += `<p class="small muted" style="margin:8px 0 0">Normal for today: ${Math.round(fl.p25)}–${Math.round(fl.p75)} cfs (median ${Math.round(fl.p50)}).</p>`;
  if (wx && wx.days && wx.days.length > 1) {
    h += `<div class="fc">${wx.days.slice(0, 4).map((d) => `<div><b>${new Date(d.date + 'T12:00').toLocaleDateString([], { weekday: 'short' })}</b><br>${d.max}°/${d.min}°<br><span class="muted">${esc(codeText(d.code))}</span></div>`).join('')}</div>`;
  }
  if (wx) h += `<p class="small muted" style="margin:8px 0 0">Weather updated ${ago(wx.fetchedAt)}.</p>`;
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
  let h = `<div class="card small"><b>${esc(S.manual ? 'Manual conditions' : S.site.name)}</b><br>
    ${c.species === 'steelhead' ? 'Steelhead / salmon' : 'Trout'} · water ${c.waterTempF}°F (${tempSrc}) · flow ${cond.flowBand || 'unknown'}${c.flowTrend ? ` ${trendArrow(c.flowTrend)}` : ''} · ${c.clarity} · ${c.waterType} ${c.depthFt} ft · ${c.tod}</div>`;
  for (const w of r.warnings) h += `<div class="alert ${w.level}">${w.level === 'stop' ? '🛑 ' : '⚠️ '}${esc(w.text)}</div>`;
  if (r.notes.length) h += `<div class="card"><h2>Reading the river</h2><ul class="notes">${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>`;

  const top = r.setups.slice(0, 3), rest = r.setups.slice(3);
  top.forEach((s, k) => { h += setupCard(s, k); });
  h += fromBoxCard(r.fromBox);
  if (rest.length) h += `<details class="more card"><summary>More options (${rest.length})</summary>${rest.map((s, k) => setupCard(s, k + 3, true)).join('')}</details>`;
  return h;
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

function setupCard(s, k, inner, rankHtml, extraClass = '') {
  const rank = ['Best bet', '2nd choice', '3rd choice'][k] || 'Option';
  return `<div class="${inner ? '' : 'card '}setup ${extraClass}">${rankHtml || `<div class="rank">${rank}</div>`}<h2>${esc(s.title)}</h2>
    <ul class="why">${s.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
    <dl class="kv"><dt>Rod</dt><dd>${esc(s.rod.text)}${s.rod.note ? `<br><span class="small muted">${esc(s.rod.note)}</span>` : ''}</dd>
    <dt>Line</dt><dd>${esc(s.line)}</dd></dl>
    <h3>Rig, top to bottom</h3>${rigDiagram(s.rig)}
    <h3>Flies</h3><ul class="fly-list">${s.flies.map((f) => `<li><span>${f.owned ? '<span class="own">✓ </span>' : ''}${esc(f.name)}</span><span class="role">${esc(f.role)}</span></li>`).join('')}</ul>
    ${s.flies.some((f) => f.owned) ? '<p class="small muted" style="margin:0 0 6px">✓ = in your fly box</p>' : ''}
    <h3>Tips</h3><ul class="notes">${s.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    <p style="margin:12px 0 0"><button style="width:100%" data-act="logthis" data-key="${s.key}"${extraClass === 'boxsetup' ? ' data-box="1"' : ''}>🐟 Caught one on this? Log it</button></p>
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

const TECH = [['dry', 'Dry fly'], ['drydropper', 'Dry-dropper'], ['nymph', 'Indicator nymph'], ['euro', 'Euro nymph'], ['streamer', 'Streamer'], ['softhackle', 'Soft hackle'], ['swing', 'Swing'], ['skate', 'Skated dry'], ['shnymph', 'Egg / nymph (steelhead)']];
const techName = (k) => (TECH.find((t) => t[0] === k) || [k, k])[1];

function viewLog() {
  let h = '';
  const d = S.logDraft;
  if (d) {
    h += `<div class="card"><h2>Log a catch</h2>
      <label class="field">Species</label>${chips('log.species', [['trout', 'Trout'], ['steelhead', 'Steelhead / Salmon']], d.species)}
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
        <div class="small">${esc(techName(c.technique))} · ${c.species === 'steelhead' ? 'Steelhead/Salmon' : 'Trout'} · ${new Date(c.date).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</div>
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
  const cond = S.site || S.manual ? currentConditions() : null;
  const res = lastResult;
  const setup = !res || !key ? null
    : fromBox && res.fromBox && res.fromBox.setup ? res.fromBox.setup
      : res.setups.find((s) => s.key === key);
  S.logDraft = {
    species: S.inputs.species, technique: key || (S.inputs.species === 'steelhead' ? 'swing' : 'nymph'),
    fly: setup ? setup.flies[0].name.replace(/^(Tag|Point):\s*/, '') : '', length: '', notes: '', photo: null,
    flyOptions: res ? [...new Set(res.setups.flatMap((s) => s.flies.map((f) => f.name)))] : [],
    cond: cond ? {
      site: S.manual ? 'manual' : S.site.name, waterTempF: res ? res.cond.waterTempF : cond.waterTempF,
      cfs: S.manual ? null : S.site.cfs, flowBand: cond.flowBand, clarity: cond.clarity, waterType: cond.waterType,
      depthFt: cond.depthFt, month: new Date().getMonth() + 1,
    } : null,
  };
  S.tab = 'log'; render(); window.scrollTo(0, 0);
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
  else if (act === 'manual') { S.picking = false; S.manual = true; S.site = null; S.wx = null; S.flow = null; saveSession(); render(); window.scrollTo(0, 0); if (navigator.onLine) manualWeatherFromGps(); }
  else if (act === 'pick' || act === 'fav') {
    // Switch straight to the "chosen" view so the tap is obviously registered.
    S.picking = false; window.scrollTo(0, 0);
    selectSite((act === 'pick' ? S.nearby : S.favorites)[+b.dataset.k]);
  }
  else if (act === 'change') { S.picking = true; S.query = ''; render(); window.scrollTo(0, 0); }
  else if (act === 'back') { S.picking = false; render(); window.scrollTo(0, 0); }
  else if (act === 'clearq') { S.query = ''; S.nearby = null; S.nearbyTitle = ''; render(); document.getElementById('q').focus(); }
  else if (act === 'star') {
    const s = S.site, i = S.favorites.findIndex((f) => f.id === s.id);
    if (i >= 0) S.favorites.splice(i, 1); else S.favorites.push({ id: s.id, name: s.name, lat: s.lat, lon: s.lon });
    await store.set('favorites', S.favorites); render();
    toast(i >= 0 ? 'Removed from saved rivers' : 'Saved. Use "Download for offline" before you lose signal.');
  }
  else if (act === 'prep') tripPrep();
  else if (act === 'set') {
    const f = b.dataset.f, v = b.dataset.v;
    if (f.startsWith('log.')) S.logDraft[f.slice(4)] = v; else { S.inputs[f] = v; saveSession(); }
    const y = window.scrollY; render(); window.scrollTo(0, y);
  }
  else if (act === 'go') { S.tab = 'setups'; render(); window.scrollTo(0, 0); }
  else if (act === 'logthis') startLog(b.dataset.key, !!b.dataset.box);
  else if (act === 'newlog') startLog(null);
  else if (act === 'cancellog') { S.logDraft = null; render(); }
  else if (act === 'savelog') {
    const d = S.logDraft;
    S.catches.push({ date: Date.now(), species: d.species, technique: d.technique, fly: d.fly.trim(), length: d.length, notes: d.notes, photo: d.photo, cond: d.cond });
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
  S.prep = await store.get('prepMsg', '');
  const sess = await store.get('session');
  if (sess) {
    S.inputs = { ...DEFAULT_INPUTS, ...sess.inputs };
    S.manual = !!sess.manual;
    if (sess.site) { selectSite(sess.site); return; }
    if (S.manual) { S.wx = await store.get('wx:gps'); }
  }
  render();
})();
