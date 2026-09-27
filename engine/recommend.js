// Rules engine: turns river conditions into ranked fly-fishing setups.
// No network, no AI calls: everything is decided by the rules below plus the
// editable tables in /knowledge.
import {
  tippetX, xLabel, dryLeaderFt, speedIndex, indicatorDepthFt, splitShot,
  euroBeadMm, pickRod, hasRodType, hookSizeOf,
} from './rigging.js';

const MONTH_WATER_F = [37, 38, 41, 46, 51, 56, 60, 60, 55, 49, 43, 38];

// ---------- condition helpers ----------

export function regionFor(lon) {
  return lon != null && lon < -104 ? 'west' : 'east';
}

export function estimateWaterTempF(past3AvgAirF, month) {
  if (past3AvgAirF != null) return Math.max(33, Math.min(80, Math.round(0.8 * past3AvgAirF + 8)));
  return MONTH_WATER_F[month - 1];
}

export function timeOfDay(now, sunrise, sunset) {
  const h = now.getHours() + now.getMinutes() / 60;
  const sr = sunrise ? sunrise.getHours() + sunrise.getMinutes() / 60 : 6.5;
  const ss = sunset ? sunset.getHours() + sunset.getMinutes() / 60 : 19.5;
  if (h < sr - 0.5 || h > ss + 0.5) return 'night';
  if (h < sr + 1.5) return 'dawn';
  if (h < 11) return 'morning';
  if (h < 14) return 'midday';
  if (h < ss - 1.5) return 'afternoon';
  return 'evening';
}

function skyTags(wx) {
  const t = new Set();
  if (!wx) return t;
  if (wx.cloud >= 70) t.add('overcast');
  if (wx.cloud != null && wx.cloud < 30) t.add('sun');
  if (wx.precip > 0) { t.add('drizzle'); t.add('overcast'); }
  if (wx.windMph >= 10) t.add('wind');
  if (wx.windMph != null && wx.windMph < 5) t.add('calm');
  if (wx.airF >= 70) t.add('warm');
  return t;
}

const isHigh = (b) => b === 'high' || b === 'very high';
const isLow = (b) => b === 'low' || b === 'very low';

// ---------- hatch scoring ----------

export function scoreHatches(hatches, c) {
  const tod = c.tod === 'dawn' ? 'morning' : c.tod === 'night' ? 'evening' : c.tod;
  const prev = ((c.month + 10) % 12) + 1, next = (c.month % 12) + 1;
  return hatches.map((h) => {
    if (!h.regions.includes('all') && !h.regions.includes(c.region)) return { h, score: 0 };
    let monthF = h.months.includes(c.month) ? 1 : (h.months.includes(prev) || h.months.includes(next)) ? 0.4 : 0;
    if (!monthF) return { h, score: 0 };
    const [lo, hi] = h.temp;
    const T = c.waterTempF;
    let tempF = T == null ? 0.7 : T >= lo && T <= hi ? 1 : (T >= lo - 3 && T <= hi + 3) ? 0.5 : 0.1;
    const timeF = h.time.includes(tod) ? 1 : 0.6;
    let s = h.base * monthF * tempF * timeF;
    for (const b of h.boost) if (c.sky.has(b)) s += 0.12;
    return { h, score: Math.round(s * 100) / 100 };
  }).filter((x) => x.score > 0.15).sort((a, b) => b.score - a.score);
}

// ---------- main entry ----------

export function recommend(cond, kb, gear = {}, catches = []) {
  const now = cond.now || new Date();
  const c = {
    ...cond,
    month: cond.month || now.getMonth() + 1,
    clarity: cond.clarity || 'clear',
    waterType: cond.waterType || 'run',
    depthFt: cond.depthFt || 3,
    flowBand: cond.flowBand || 'normal',
    sky: skyTags(cond.weather),
    region: cond.region || 'west',
  };
  c.tod = cond.tod || timeOfDay(now, cond.sunrise, cond.sunset);
  if (c.waterTempF == null) {
    c.waterTempF = estimateWaterTempF(cond.weather && cond.weather.past3AvgAirF, c.month);
    c.tempEstimated = true;
  }
  c.speed = speedIndex(c.waterType, c.flowBand);
  c.lowLight = c.tod === 'dawn' || c.tod === 'evening' || c.sky.has('overcast');

  const out = c.species === 'steelhead' ? steelhead(c, kb, gear) : trout(c, kb, gear);
  applyHistory(out.setups, c, catches);
  markOwnedFlies(out.setups, gear);
  out.setups.sort((a, b) => b.score - a.score);
  out.cond = c;
  out.fromBox = buildFromBox(out, c, kb, gear);
  return out;
}

// ---------- "from your fly box" ----------

// "Tag: Zebra Midge (black/red) #18-22" -> "zebra midge"
export const flyKey = (n) => String(n).replace(/^(tag|point):\s*/i, '').split(/[#(]/)[0]
  .replace(/\s+\d[\d.\-]*\s*(in|mm)?\s*\+?$/i, '').trim().toLowerCase();

// What each fly slot in a setup needs, top to bottom (matches the order of 'fly' parts in the rig).
const SLOTS = {
  dry: ['dry'], drydropper: ['dry', 'nymph'], nymph: ['nymph', 'nymph'], euro: ['nymph', 'nymph'],
  streamer: ['streamer'], softhackle: ['emerger', 'emerger'],
  swing: ['swing'], skate: ['skater'], shnymph: ['egg', 'egg'],
};
// Which fly types can fill each slot, best first.
const ACCEPTS = {
  dry: ['dry'], nymph: ['nymph'], emerger: ['emerger'], streamer: ['streamer'],
  swing: ['swing', 'streamer'], skater: ['skater'], egg: ['egg', 'nymph'],
};

function flyTypes(kb) {
  const hs = kb.hatches.hatches, fl = kb.flies, sh = kb.steelhead;
  const set = (names) => new Set(names.map(flyKey));
  return {
    dry: set([...hs.flatMap((h) => h.dry), ...fl.attractor_dries]),
    emerger: set([...hs.flatMap((h) => h.emerger), ...fl.soft_hackles]),
    nymph: set([...hs.flatMap((h) => h.nymph), ...Object.values(fl.nymphs).flat(), ...fl.winter_nymphs, 'Perdigon', "Walt's Worm"]),
    streamer: set(Object.values(fl.streamers).flat()),
    swing: set(Object.values(sh.swing_flies).flatMap((x) => x.patterns)),
    skater: set(sh.skaters),
    egg: set(Object.values(sh.nymph_flies).flat()),
  };
}

// Knowledge-table flies that suit today's clarity, per fly type.
function clarityFlies(kb, clarity) {
  const fl = kb.flies, sh = kb.steelhead;
  return {
    nymph: fl.nymphs[clarity] || [], streamer: fl.streamers[clarity] || [],
    swing: (sh.swing_flies[clarity] || { patterns: [] }).patterns, egg: sh.nymph_flies[clarity] || [],
    dry: fl.attractor_dries, emerger: fl.soft_hackles, skater: sh.skaters,
  };
}

function buildFromBox(out, c, kb, gear) {
  const box = ((gear && gear.flies) || []).map((f) => f.trim()).filter(Boolean);
  if (!box.length) return { status: 'empty' };
  const types = flyTypes(kb);
  const clar = clarityFlies(kb, c.clarity);
  const hatchFlies = { dry: [], emerger: [], nymph: [] };
  for (const { h } of out.hatches || []) {
    hatchFlies.dry.push(...h.dry); hatchFlies.emerger.push(...h.emerger); hatchFlies.nymph.push(...h.nymph);
  }
  const owned = box.map((name) => ({ name, key: flyKey(name) }));
  const typeOf = (key) => Object.keys(types).filter((t) => types[t].has(key));

  let best = null;
  out.setups.forEach((s, rank) => {
    const slots = SLOTS[s.key];
    if (!slots) return;
    const flyParts = s.rig.filter((p) => p.kind === 'fly');
    const used = new Set();
    const picks = [];
    let penalty = 0;
    for (const [i, slot] of slots.entries()) {
      const wanted = flyParts[i] ? flyParts[i].label : '';
      const wantedKey = flyKey(wanted);
      const setupKeys = new Set(s.flies.map((f) => flyKey(f.name)));
      const hatchKeys = new Set((hatchFlies[slot] || []).map(flyKey));
      const clarKeys = new Set((clar[slot] || []).map(flyKey));
      let pick = null;
      for (const o of owned) {
        if (used.has(o.key)) continue;
        const accepted = ACCEPTS[slot].findIndex((t) => typeOf(o.key).includes(t));
        if (accepted < 0) continue;
        // Lower cost = better match for this slot.
        const cost = o.key === wantedKey ? 0 : setupKeys.has(o.key) ? 3 : hatchKeys.has(o.key) ? 5 : clarKeys.has(o.key) ? 8 : 15;
        const total = cost + accepted * 5;
        if (!pick || total < pick.cost) pick = { ...o, cost: total, wanted, why: cost === 0 ? 'exact' : cost === 3 ? 'listed' : cost === 5 ? 'hatch' : cost === 8 ? 'clarity' : 'type' };
      }
      if (!pick) return; // can't fill this slot from the box
      used.add(pick.key);
      picks.push(pick);
      penalty += pick.cost;
    }
    const total = s.score - penalty;
    if (!best || total > best.total) best = { s, rank, picks, total, penalty };
  });
  if (!best) return { status: 'nomatch' };
  if (best.rank === 0 && best.penalty === 0) return { status: 'topOwned' };

  // Build a copy of the setup with the box flies swapped in.
  const s = best.s;
  // Box entries are pattern names without sizes. Carry the recommended size over only
  // when the substitute imitates the same kind of bug; otherwise use the pattern's usual size.
  for (const p of best.picks) {
    const size = /#\d+(?:-\d+)?/.exec(p.wanted);
    if (size && !/#\d/.test(p.name) && ['exact', 'listed', 'hatch'].includes(p.why)) p.name = `${p.name} ${size[0]}`;
  }
  let fi = 0;
  const rig = s.rig.map((p) => {
    if (p.kind !== 'fly') return { ...p };
    const pick = best.picks[fi++];
    const prefix = /^(Tag|Point):/i.exec(p.label);
    return { ...p, label: `${prefix ? prefix[0] + ' ' : ''}${pick.name}`, detail: p.detail };
  });
  const reason = {
    exact: 'the exact fly recommended', listed: 'one of the recommended patterns', hatch: 'it matches a bug that should be hatching',
    clarity: 'it suits today\'s water clarity', type: 'it\'s the closest type you carry',
  };
  const why = ['Built from flies you already carry.'];
  best.picks.forEach((p, i) => {
    if (p.why === 'exact') return;
    // For dries, emergers and skaters the "clarity" list is really the general attractor list.
    const r = p.why === 'clarity' && ['dry', 'emerger', 'skater'].includes(SLOTS[s.key][i]) ? 'it\'s a reliable all-round pattern' : reason[p.why];
    why.push(`${p.name} in place of ${p.wanted.replace(/^(Tag|Point):\s*/i, '')}: ${r}.`);
  });
  return {
    status: 'ok',
    setup: {
      ...s, title: s.title, score: best.total, why, rig,
      flies: best.picks.map((p, i) => ({ name: p.name, role: SLOTS[s.key][i], owned: true })),
    },
  };
}

// ---------- TROUT ----------

function trout(c, kb, gear) {
  const T = c.waterTempF;
  const warnings = [], notes = [], setups = [];
  const clar = c.clarity, fb = c.flowBand;

  if (T >= 68) warnings.push({ level: 'stop', text: `Water is ${T}°F. Trout caught above 68°F often die after release. Please stop fishing for trout, or only fish the first hour of daylight, land fish fast and keep them wet.` });
  else if (T >= 65) warnings.push({ level: 'caution', text: `Water is ${T}°F, close to the 68°F danger line. Fish early, use heavier tippet to land fish fast, and keep them in the water.` });
  if (T <= 36) notes.push('Very cold water. Trout are sluggish, so fish slow and deep in the softest water, in the warmest part of the day.');
  if (clar === 'muddy' && fb === 'very high') warnings.push({ level: 'caution', text: 'River looks blown out (very high and muddy). Fishing will be tough. Try the soft edges with big dark streamers or worms, or find a tributary or tailwater.' });
  if (c.flowTrend === 'rising') notes.push('Flow is rising. Fish often feed hard early in a rise, then shut down as it muddies. Move to the soft edges.');
  if (c.flowTrend === 'falling' && isHigh(fb)) notes.push('High water that is dropping and clearing is often prime time for nymphs and streamers.');
  if (isLow(fb) && clar === 'clear') notes.push('Low, clear water: fish are spooky. Use long leaders and fine tippet, approach from downstream, and keep off the skyline.');
  if (c.weather && c.weather.pressureTrend === 'falling') notes.push('The barometer is falling ahead of weather, which is often a strong bite window.');
  if (c.weather && c.weather.pressureTrend === 'rising' && c.sky.has('sun')) notes.push('A bright day after a front usually means a tougher bite. Go smaller and deeper, tight to cover.');
  if (c.tempEstimated) notes.push(`Water temp is estimated at about ${T}°F from air temps. Use a thermometer and enter the real reading for better advice.`);

  const hatches = scoreHatches(kb.hatches.hatches, c);
  const top = hatches[0];
  const likely = hatches.filter((x) => x.score >= 0.35).slice(0, 3);
  const bugNames = likely.map((x) => x.h.name);
  if (likely.length) notes.push(`Most likely bugs right now: ${bugNames.join(', ')}.`);

  const nymphClar = kb.flies.nymphs[clar];
  const cold = T < 45;

  // 1. Dry fly: match the hatch
  if (top && top.h.dry.length) {
    let s = 35 + top.score * 45;
    const why = [`${top.h.name} are the most likely hatch for ${monthName(c.month)} at ${T}°F.`];
    if (clar === 'stained') s -= 20;
    if (clar === 'muddy') s -= 50;
    if (fb === 'high') s -= 15;
    if (fb === 'very high') s -= 35;
    if (T < 45) { s -= 12; why.push('Cold water means a short, midday-only dry window.'); }
    if (c.tod === 'night') s -= 30;
    if (c.weather && c.weather.windMph > 15) { s -= 10; why.push('Wind will make drifts tricky.'); }
    if (top.h.boost.some((b) => c.sky.has(b))) why.push(`Today's weather (${[...c.sky].join(', ')}) suits this hatch.`);
    const size = top.h.size;
    const x = tippetX(size, clar, fb);
    const leader = dryLeaderFt(clar, fb);
    const rod = pickRod(gear, { wt: size >= 18 && clar === 'clear' ? 4 : 5, types: ['single'] });
    setups.push({
      key: 'dry', title: `Dry fly: ${top.h.name}`, score: s, why,
      rod, line: 'Weight-forward floating line',
      rig: [
        { kind: 'line', label: 'Floating fly line' },
        { kind: 'leader', label: `${leader} ft tapered leader to ${xLabel(x)}` },
        { kind: 'tippet', label: `+ 2 ft of ${xLabel(x)} nylon tippet`, detail: 'Nylon floats better than fluoro for dries' },
        { kind: 'fly', label: top.h.dry[0], detail: 'Dry fly' },
      ],
      flies: [...top.h.dry.map((n) => ({ name: n, role: 'dry' })), ...top.h.emerger.map((n) => ({ name: n, role: 'emerger (if they refuse the dry)' }))],
      tips: [
        'Look for rising fish in the slow seams and tailouts before you cast.',
        top.h.emerger.length ? 'If fish splash or refuse, switch to the emerger. They are eating just under the surface.' : 'Dead drift with no drag. Mend early.',
      ],
    });
  }

  // 2. Dry-dropper (hopper-dropper in terrestrial season)
  {
    const terr = hatches.find((x) => x.h.name.startsWith('Terrestrials') && x.score >= 0.35);
    let s = 45;
    const why = [];
    if (T >= 50 && T <= 66) { s += 10; why.push('Water temps have fish looking up and down.'); }
    if (c.depthFt <= 4) { s += 10; why.push(`At ${c.depthFt} ft deep, a dropper covers the whole water column.`); } else s -= 12;
    if (['riffle', 'pocket', 'run'].includes(c.waterType)) s += 5;
    if (terr) { s += 10; why.push('Terrestrial season: a hopper on top gets explosive takes, especially on windy banks.'); }
    if (clar === 'stained') s -= 10;
    if (clar === 'muddy') s -= 40;
    if (isHigh(fb)) s -= 10;
    if (cold) s -= 15;
    const dry = terr ? terr.h.dry[0] : top && top.h.size <= 12 && top.h.dry.length ? top.h.dry[0] : kb.flies.attractor_dries[c.month >= 6 && c.month <= 9 ? 2 : 1];
    const dropper = top && top.h.nymph.length ? top.h.nymph[0] : nymphClar[0];
    const drySize = hookSizeOf(dry, 10);
    const x = tippetX(drySize, clar, fb);
    const dx = Math.min(7, tippetX(hookSizeOf(dropper, 16), clar, fb));
    const dropFt = Math.max(1.5, Math.min(3.5, Math.round(c.depthFt * 0.6 * 2) / 2));
    const rod = pickRod(gear, { wt: terr ? 6 : 5, types: ['single'] });
    setups.push({
      key: 'drydropper', title: terr ? 'Hopper-dropper' : 'Dry-dropper', score: s,
      why: why.length ? why : ['A versatile search rig for when you are not sure what they are eating.'],
      rod, line: 'Weight-forward floating line',
      rig: [
        { kind: 'line', label: 'Floating fly line' },
        { kind: 'leader', label: `7.5-9 ft leader to ${xLabel(x)}` },
        { kind: 'fly', label: dry, detail: 'Dry fly (also acts as your indicator)' },
        { kind: 'tippet', label: `${dropFt} ft of ${xLabel(dx)} fluoro, tied to the dry's hook bend`, detail: 'Clinch knot on the bend' },
        { kind: 'fly', label: dropper, detail: 'Bead-head dropper' },
      ],
      flies: [{ name: dry, role: 'dry / indicator' }, { name: dropper, role: 'dropper' }, ...nymphClar.slice(0, 2).filter((n) => n !== dropper).map((n) => ({ name: n, role: 'alternate dropper' }))],
      tips: ['If the dry sinks, the dropper is too heavy. Go to a smaller bead or a bigger dry.', 'Cast to the seams and let the rig drift drag-free.'],
    });
  }

  // 3. Indicator nymph
  {
    let s = 55;
    const why = [];
    if (cold) { s += 15; why.push(`At ${T}°F, trout feed near the bottom and won't move far.`); }
    if (c.depthFt >= 3) { s += 8; why.push(`Deep water (${c.depthFt} ft) is where an indicator rig shines.`); }
    if (['pool', 'run'].includes(c.waterType)) s += 5;
    if (c.waterType === 'flat') s -= 10;
    if (clar === 'stained') { s += 5; why.push('Stained water: bright worms and eggs stand out.'); }
    if (isHigh(fb)) { s += 5; why.push('High water pushes fish to the bottom and the edges.'); }
    if (c.sky.has('sun') && c.tod === 'midday') s += 5;
    if (!why.length) why.push('Most of a trout\'s diet is nymphs. This is the most reliable way to catch fish most days.');
    const winter = c.month <= 3 || c.month === 12;
    const drop = top && top.h.nymph.length ? top.h.nymph[0] : winter ? kb.flies.winter_nymphs[0] : nymphClar[1];
    const base = (n) => n.split(/[#(]/)[0].trim();
    // Point fly: heavier/bigger than the dropper, and never the same pattern.
    const pointOptions = clar === 'stained' || clar === 'muddy' ? nymphClar
      : winter ? [kb.flies.winter_nymphs[1], ...kb.flies.winter_nymphs]
      : c.depthFt >= 4 || c.speed >= 2 ? ['Pat\'s Rubber Legs #8-10', ...kb.flies.nymphs.slight]
      : kb.flies.nymphs.slight;
    const point = pointOptions.find((n) => base(n) !== base(drop)) || pointOptions[0];
    const x1 = Math.max(2, tippetX(hookSizeOf(point, 12), clar, fb) - 1);
    const x2 = Math.min(7, tippetX(hookSizeOf(drop, 16), clar, fb));
    const ind = indicatorDepthFt(c.depthFt, c.speed);
    const rod = pickRod(gear, { wt: 5, types: ['single'] });
    setups.push({
      key: 'nymph', title: 'Indicator nymph rig', score: s, why, rod, line: 'Floating line (a nymph or indicator taper is ideal)',
      rig: [
        { kind: 'line', label: 'Floating fly line' },
        { kind: 'leader', label: `9 ft leader to ${xLabel(x1)}` },
        { kind: 'indicator', label: `Indicator ${ind} ft above the split shot`, detail: `≈1.5-2x water depth (${c.depthFt} ft)` },
        { kind: 'shot', label: splitShot(c.speed, c.depthFt), detail: 'Above the tippet knot' },
        { kind: 'tippet', label: `18 in of ${xLabel(x1)} fluoro` },
        { kind: 'fly', label: point, detail: 'Heavier point fly' },
        { kind: 'tippet', label: `16-20 in of ${xLabel(x2)} fluoro off the hook bend` },
        { kind: 'fly', label: drop, detail: 'Smaller "food" fly' },
      ],
      flies: [{ name: point, role: 'point fly' }, { name: drop, role: 'dropper' }, ...(top ? top.h.nymph.slice(1, 3) : nymphClar.slice(2)).map((n) => ({ name: n, role: 'alternate' }))],
      tips: ['If you are not ticking bottom now and then, add weight or move the indicator up.', 'Set the hook on any hesitation of the indicator.'],
    });
  }

  // 4. Euro nymph
  {
    let s = 45;
    const why = [];
    if (['pocket', 'riffle'].includes(c.waterType)) { s += 20; why.push('Fast pocket water and riffles are made for tight-line nymphing.'); }
    if (c.waterType === 'run') s += 8;
    if (c.waterType === 'pool') s -= 15;
    if (c.waterType === 'flat') s -= 25;
    if (c.depthFt > 6) s -= 10;
    if (clar === 'stained') { s += 3; why.push('Stained water lets you get close to fish without spooking them.'); }
    const hasEuro = hasRodType(gear, 'euro');
    if (!hasEuro && gear.rods && gear.rods.length) { s -= 10; }
    if (!why.length) why.push('Direct contact with the flies gives the most strikes in moving water.');
    const bead = euroBeadMm(c.speed, c.depthFt);
    const drop = top && top.h.nymph.length ? top.h.nymph[0] : 'Frenchie #16';
    const x = clar === 'clear' ? 6 : 5;
    const rod = hasEuro ? pickRod(gear, { wt: 3, len: 10, types: ['euro'] }) : { text: '10-11 ft 2-4wt euro rod', note: gear.rods && gear.rods.length ? 'No euro rod in your gear. A 9ft 5wt with a mono rig works in short range.' : null };
    setups.push({
      key: 'euro', title: 'Euro (tight-line) nymphing', score: s, why, rod, line: 'Mono rig (no fly line out of the guides)',
      rig: [
        { kind: 'line', label: '20+ ft of 12-20 lb mono "butt"', detail: 'Or a dedicated euro line' },
        { kind: 'sighter', label: '2-3 ft two-tone sighter', detail: 'Watch it for any hesitation' },
        { kind: 'leader', label: 'Tippet ring' },
        { kind: 'tippet', label: `3-4 ft of ${xLabel(x)} fluoro` },
        { kind: 'fly', label: `Tag: ${drop} (tungsten ${bead === '2.5 mm' ? '2.5' : '2.8'} mm)`, detail: 'On a 6 in tag, 20 in above the point' },
        { kind: 'fly', label: `Point: Perdigon or Walt's Worm, ${bead} tungsten`, detail: 'Heavier anchor fly' },
      ],
      flies: [{ name: `Perdigon (olive/black) ${bead}`, role: 'anchor' }, { name: drop, role: 'tag fly' }, { name: "Walt's Worm #14-16", role: 'alternate anchor' }, { name: 'Frenchie #14-16', role: 'alternate tag' }],
      tips: ['Lead the flies downstream just slightly faster than the current.', 'Keep the sighter at a 45° angle. If it hesitates, set.'],
    });
  }

  // 5. Streamer
  {
    let s = 35;
    const why = [];
    if (clar === 'stained') { s += 20; why.push('Stained water: big, dark streamers get noticed and fish feel safe to chase.'); }
    if (clar === 'slight') s += 10;
    if (clar === 'muddy') { s += 10; why.push('In muddy water, big dark flies push water that fish can feel.'); }
    if (c.flowTrend === 'rising') { s += 15; why.push('Rising water knocks baitfish loose, so big trout go hunting.'); }
    if (isHigh(fb)) s += 12;
    if (c.lowLight) { s += 15; why.push('Low light (dawn, dusk or clouds) is prime streamer time.'); }
    if (c.month >= 9 && c.month <= 11) { s += 10; why.push('Fall: pre-spawn brown trout get aggressive.'); }
    if (c.weather && c.weather.pressureTrend === 'falling') s += 5;
    if (T < 40) s -= 10;
    if (c.sky.has('sun') && clar === 'clear' && !isHigh(fb)) s -= 15;
    if (!why.length) why.push('Streamers target the biggest fish in the river.');
    const deep = c.depthFt >= 4 || isHigh(fb);
    const flies = kb.flies.streamers[clar];
    const rod = pickRod(gear, { wt: clar === 'stained' || clar === 'muddy' ? 7 : 6, types: ['single'] });
    const x = clar === 'clear' ? 2 : 0;
    setups.push({
      key: 'streamer', title: 'Streamer', score: s, why, rod,
      line: deep ? 'Sink-tip or full intermediate line (or a 10 ft type 6 sinking polyleader)' : 'Floating line with a 7 ft sinking polyleader',
      rig: [
        { kind: 'line', label: deep ? 'Sink-tip / intermediate line' : 'Floating line' },
        ...(deep ? [] : [{ kind: 'sinktip', label: 'Sinking polyleader (optional)' }]),
        { kind: 'leader', label: `Short 4-6 ft leader, ${xLabel(x)} (${x === 0 ? '12-15' : '8-10'} lb)`, detail: 'Short leader keeps the fly at the line\'s depth' },
        { kind: 'fly', label: flies[0], detail: 'Non-slip loop knot for more action' },
      ],
      flies: flies.map((n, i) => ({ name: n, role: i === 0 ? 'first choice' : 'alternate' })),
      tips: [
        T < 45 ? 'Cold water: swing and dead-drift slowly with short twitches. Don\'t strip fast.' : 'Bang the banks and strip back with erratic pauses. Vary the speed until they tell you what they like.',
        'Strip-set, don\'t trout-set. Keep the rod tip low.',
      ],
    });
  }

  // 6. Swung soft hackles, when caddis or mayflies are emerging
  {
    const emerg = likely.find((x) => /Caddis|March|Mahogany|Hendrickson/.test(x.h.name));
    if (emerg && ['afternoon', 'evening'].includes(c.tod)) {
      let s = 35 + emerg.score * 35 + (['riffle', 'run'].includes(c.waterType) ? 10 : 0);
      if (clar === 'muddy') s -= 30;
      const fly = emerg.h.emerger[0] || kb.flies.soft_hackles[0];
      const x = tippetX(hookSizeOf(fly, 14), clar, fb);
      setups.push({
        key: 'softhackle', title: 'Swung soft hackles', score: s,
        why: [`${emerg.h.name} are emerging. Swinging imitates the rising pupae and gets hard takes.`],
        rod: pickRod(gear, { wt: 5, types: ['single', 'switch'] }), line: 'Floating line',
        rig: [
          { kind: 'line', label: 'Floating fly line' },
          { kind: 'leader', label: `9 ft leader to ${xLabel(x)}` },
          { kind: 'fly', label: fly, detail: 'Point fly' },
          { kind: 'tippet', label: '24 in dropper' },
          { kind: 'fly', label: kb.flies.soft_hackles[1], detail: 'Second soft hackle' },
        ],
        flies: [...emerg.h.emerger, ...kb.flies.soft_hackles].map((n) => ({ name: n, role: 'soft hackle' })),
        tips: ['Cast across and slightly down, then let the current swing the flies. Takes come as the flies rise at the end.', 'Don\'t strike hard. Let the fish turn and hook itself.'],
      });
    }
  }

  return { warnings, notes, hatches: likely, setups };
}

// ---------- STEELHEAD / SALMON ----------

function steelhead(c, kb, gear) {
  const T = c.waterTempF;
  const sh = kb.steelhead;
  const warnings = [], notes = [], setups = [];
  const clar = c.clarity, fb = c.flowBand;

  if (T >= 68) warnings.push({ level: 'stop', text: `Water is ${T}°F. That is lethal territory for steelhead and salmon. Please don't fish today.` });
  else if (T >= 64) warnings.push({ level: 'caution', text: `Water is ${T}°F. Fish are stressed, so fish at first light, use heavy tippet and keep them wet.` });
  if (clar === 'muddy') warnings.push({ level: 'caution', text: 'Under 1 ft of visibility is tough steelhead water. Fish the soft inside edges with big, dark or bright flies, or wait for it to clear.' });
  if (c.flowTrend === 'falling' && (isHigh(fb) || clar === 'stained')) notes.push('Dropping and clearing after a rise is prime time. Fresh fish are moving.');
  if (c.flowTrend === 'rising') notes.push('Rising water often turns fish off for a while. Focus on the soft edges and tailouts.');
  if (c.lowLight) notes.push('Low light: steelhead are more willing to move for a swung fly.');
  if (c.tempEstimated) notes.push(`Water temp is estimated at about ${T}°F. A thermometer reading will sharpen the sink-tip choice a lot.`);
  notes.push('Check local regulations. Some rivers restrict bait-like flies, beads or indicators.');

  // sink tip choice
  let tipIdx = sh.tips.findIndex((t) => T <= t.maxTemp);
  if (tipIdx < 0) tipIdx = sh.tips.length - 1;
  if (isHigh(fb) || c.depthFt >= 6) tipIdx = Math.max(0, tipIdx - 1);
  if (isLow(fb) && c.depthFt <= 3) tipIdx = Math.min(sh.tips.length - 1, tipIdx + 1);
  const tip = sh.tips[tipIdx];
  const swingFlies = sh.swing_flies[clar];
  const leaderLb = clar === 'clear' ? '10-12' : '12-15';

  // 1. Swing
  {
    let s = 60;
    const why = [tip.why];
    if (clar === 'clear' || clar === 'slight') s += 10;
    if (clar === 'muddy') s -= 20;
    if (c.flowTrend === 'falling') s += 8;
    if (c.lowLight) s += 8;
    if (T >= 42 && T <= 55) { s += 10; why.push(`${T}°F is prime swinging temperature.`); }
    if (T < 36) s -= 10;
    const two = hasRodType(gear, 'spey') || hasRodType(gear, 'switch');
    const rod = two ? pickRod(gear, { wt: 7, len: 13, types: ['spey', 'switch'] })
      : gear.rods && gear.rods.length ? pickRod(gear, { wt: 8, types: ['single'] }) : { text: '13 ft 7wt spey or 11 ft 7wt switch', note: null };
    if (gear.rods && gear.rods.length && !two) { rod.note = 'A spey or switch rod makes swinging much easier. A single-hand 8wt with a sink-tip line works.'; s -= 5; }
    setups.push({
      key: 'swing', title: `Swing: ${tip.label}`, score: s, why, rod,
      line: tipIdx === sh.tips.length - 1 ? 'Skagit or Scandi head with a floating tip' : `Skagit head + ${tip.tip}`,
      tipLabel: tip.tip,
      rig: [
        { kind: 'line', label: 'Running line + Skagit head' },
        ...(tip.grain[1] ? [{ kind: 'sinktip', label: `Sink tip: ${tip.tip}`, detail: isHigh(fb) ? 'Went heavier for high flow' : '' }] : [{ kind: 'sinktip', label: 'Floating tip / polyleader' }]),
        { kind: 'leader', label: `3-4 ft of ${leaderLb} lb Maxima` },
        { kind: 'fly', label: swingFlies.patterns[0], detail: `Size ${swingFlies.size}` },
      ],
      flies: swingFlies.patterns.map((n, i) => ({ name: n, role: i === 0 ? 'first choice' : 'alternate' })),
      tips: [
        'Cast at 45° across and down, mend once, then let it swing. Take 2-3 steps between casts.',
        T < 45 ? 'Cold water: slow the swing with an upstream mend and fish the soft, walking-speed water.' : 'Let the fish turn on the take. Don\'t set until the line comes tight and heavy.',
        clar === 'stained' ? 'Stained water: try black/blue first, then pink/orange.' : 'Clear water: go sparse and smaller.',
      ],
    });
  }

  // 2. Skated dry / dry line
  if (T >= 50 && (clar === 'clear' || clar === 'slight') && !isHigh(fb)) {
    let s = 40 + (T >= 55 ? 20 : 0) + (c.lowLight ? 10 : 0);
    setups.push({
      key: 'skate', title: 'Dry line / skated fly', score: s,
      why: [`At ${T}°F, clear water steelhead will rise to a waking fly. It's the most exciting take there is.`],
      rod: pickRod(gear, { wt: 7, len: 13, types: ['spey', 'switch', 'single'] }), line: 'Scandi head or floating Skagit + floating tip',
      rig: [
        { kind: 'line', label: 'Floating line / Scandi head' },
        { kind: 'leader', label: `9-12 ft leader to ${leaderLb} lb` },
        { kind: 'fly', label: sh.skaters[0], detail: 'Riffle hitch for more wake' },
      ],
      flies: sh.skaters.map((n) => ({ name: n, role: 'skater' })),
      tips: ['Swing it so it wakes across the surface. If a fish boils and misses, cast right back or switch to a small wet fly.', 'Best at first and last light in the tailouts and riffles.'],
    });
  }

  // 3. Indicator egg / nymph
  {
    let s = 50;
    const why = [];
    if (T < 40) { s += 15; why.push('Cold water: a dead-drifted egg or nymph put right on their nose outfishes the swing.'); }
    if (clar === 'stained') { s += 10; why.push('Stained water: bright eggs are easy to see.'); }
    if (['pool', 'run'].includes(c.waterType)) s += 5;
    if (c.depthFt >= 4) s += 5;
    if (!why.length) why.push('The highest-percentage way to hook steelhead, especially in pocket water and deep slots.');
    const flies = sh.nymph_flies[clar];
    const ind = indicatorDepthFt(c.depthFt, c.speed);
    setups.push({
      key: 'shnymph', title: 'Indicator egg / nymph', score: s, why,
      rod: pickRod(gear, { wt: 8, len: 10, types: ['single', 'switch'] }), line: 'Floating line',
      rig: [
        { kind: 'line', label: 'Floating fly line' },
        { kind: 'leader', label: '7.5-9 ft leader, 15 lb butt' },
        { kind: 'indicator', label: `Indicator ${ind} ft above the shot`, detail: `≈1.5-2x depth (${c.depthFt} ft)` },
        { kind: 'shot', label: splitShot(c.speed, c.depthFt, true) },
        { kind: 'tippet', label: `18-24 in of ${clar === 'clear' ? '8' : '10-12'} lb fluoro` },
        { kind: 'fly', label: flies[0] },
        { kind: 'tippet', label: '16 in dropper' },
        { kind: 'fly', label: flies[2] || flies[1] },
      ],
      flies: flies.map((n) => ({ name: n, role: 'egg / nymph' })),
      tips: ['Dead drift through the slot so the shot ticks bottom now and then.', 'Mend to keep the indicator drifting at the speed of the bottom current.'],
    });
  }

  return { warnings, notes, hatches: [], setups };
}

// ---------- personalisation ----------

function applyHistory(setups, c, catches) {
  if (!catches || !catches.length) return;
  const similar = catches.filter((k) => {
    const kc = k.cond || {};
    if ((k.species || 'trout') !== (c.species || 'trout')) return false;
    if (kc.waterTempF != null && Math.abs(kc.waterTempF - c.waterTempF) > 6) return false;
    if (kc.clarity && kc.clarity !== c.clarity) return false;
    if (kc.flowBand && isHigh(kc.flowBand) !== isHigh(c.flowBand)) return false;
    return true;
  });
  for (const s of setups) {
    const hits = similar.filter((k) => k.technique === s.key);
    if (!hits.length) continue;
    s.score += Math.min(20, hits.length * 7);
    s.why.unshift(`This has worked for you ${hits.length}× in similar conditions.`);
    const winners = [...new Set(hits.map((k) => k.fly).filter(Boolean))].slice(0, 2);
    for (const w of winners) if (!s.flies.some((f) => f.name.toLowerCase() === w.toLowerCase())) s.flies.unshift({ name: w, role: 'your past winner' });
  }
}

function markOwnedFlies(setups, gear) {
  const box = ((gear && gear.flies) || []).map((f) => f.toLowerCase().trim()).filter(Boolean);
  if (!box.length) return;
  const key = (n) => n.toLowerCase().replace(/^(tag|point):\s*/, '').split(/[#(]/)[0].trim();
  for (const s of setups) for (const f of s.flies) {
    const k = key(f.name);
    // Exact pattern match, or a loose match for longer custom names ("rubber legs" ~ "pat's rubber legs").
    f.owned = box.includes(k) || box.some((b) => b.length >= 5 && (b.includes(k) || k.includes(b)));
  }
}

function monthName(m) {
  return ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1];
}
