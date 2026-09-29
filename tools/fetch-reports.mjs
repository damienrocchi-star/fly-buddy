// Fetches public fishing reports and writes data/reports.json. Run by the GitHub Action
// (.github/workflows/fishing-reports.yml); needs Node 20+ (built into GitHub's runners).
//   - Michigan DNR weekly fishing report (RSS + bulletin pages), split into places.
//   - Shop/guide report feeds listed in knowledge/rivers.json ("feeds"), plus feeds
//     discovered automatically from report websites ("reports").
// Only titles, dates, links and each feed's own short excerpt are kept: readers tap through
// to the source for the full report.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseFeed, parseDnr, discoverFeed } from './report-lib.mjs';
import { findTerms } from '../engine/report-signals.js';

const DNR_RSS = 'https://public.govdelivery.com/topics/MIDNR_9/feed.rss';
const OUT = 'data/reports.json';
// Browser-style identity plus our name: some shop sites' firewalls block generic "bot" identities.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 FlyBuddyReports/1.0';
const FISHY = /fish|report|river|steelhead|salmon|trout|hatch|flows?\b|guide trip/i;

async function get(url) {
  // Cache-buster: some sites answer "304 Not Modified" to feed readers without it.
  const u = new URL(url);
  u.searchParams.set('fb', String(Math.floor(Date.now() / 3600e3)));
  const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, text/html, */*' }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { return fallback; }
}

async function main() {
  const rivers = (await readJson('knowledge/rivers.json', { rivers: [] })).rivers;
  const vocab = await readJson('knowledge/report-signals.json', null);
  const prev = await readJson(OUT, { dnr: [], feeds: {} });
  const out = { fetchedAt: new Date().toISOString(), dnr: prev.dnr || [], feeds: {} };

  // Michigan DNR weekly report: the latest two bulletins.
  try {
    const items = parseFeed(await get(DNR_RSS), { limit: 2 });
    const dnr = [];
    for (const it of items) {
      const sections = parseDnr(await get(it.url));
      if (sections.length) dnr.push({ title: it.title, date: it.date, url: it.url, sections });
    }
    if (dnr.length) out.dnr = dnr;
    console.log(`DNR: ${dnr.length} bulletins, ${dnr.reduce((n, b) => n + b.sections.length, 0)} sections`);
  } catch (e) {
    console.log(`DNR: failed (${e.message}); keeping the previous copy`);
  }

  // Shop and guide feeds.
  const jobs = new Map(); // key (feed url or report site) -> { name, feedUrl, skip }
  for (const r of rivers) {
    for (const f of r.feeds || []) jobs.set(f.url, { name: f.name, feedUrl: f.url, skip: f.skip || null });
    for (const s of r.reports || []) if (!jobs.has(s.url)) jobs.set(s.url, { name: s.name, site: s.url });
  }
  for (const [key, job] of jobs) {
    try {
      let candidates = [job.feedUrl];
      if (!job.feedUrl) {
        // Discover a feed from the report page, then try the WordPress default.
        let found = null;
        try { found = discoverFeed(await get(job.site), job.site); } catch (e) { /* page unreachable */ }
        candidates = [found, new URL('/feed/', job.site).href].filter(Boolean);
      }
      let items = [], feedUrl = null;
      for (const c of candidates) {
        try { items = parseFeed(await get(c), { limit: 5, skip: job.skip, full: true }); } catch (e) { items = []; }
        if (items.length) { feedUrl = c; break; }
      }
      // Auto-discovered site feeds mix in marketing, events and recipes: keep only actual reports.
      if (!job.feedUrl) items = items.filter((it) => /report/i.test(`${it.title} ${it.url}`) && FISHY.test(`${it.title} ${it.excerpt}`));
      if (!items.length) { job.noReports = true; throw new Error('no fishing report posts'); }
      // Keep only the matched keywords from the full post (for the app's setup nudges), never the text.
      for (const it of items) {
        if (vocab) it.terms = findTerms(`${it.title}. ${it.full || it.excerpt}`, vocab);
        delete it.full;
      }
      out.feeds[key] = { name: job.name, feedUrl, items };
      console.log(`${job.name}: ${items.length} items, latest ${items[0].date?.slice(0, 10)}`);
    } catch (e) {
      // Keep the last good copy if a site is briefly down, but not when the feed simply has no reports.
      const keep = !job.noReports && prev.feeds && prev.feeds[key];
      if (keep) out.feeds[key] = prev.feeds[key];
      console.log(`${job.name}: no feed (${e.message})${keep ? '; kept previous' : ''}`);
    }
  }

  // Only write when something changed, so the repo doesn't get a commit every day.
  const same = JSON.stringify({ d: prev.dnr, f: prev.feeds }) === JSON.stringify({ d: out.dnr, f: out.feeds });
  if (same) { console.log('No changes.'); return; }
  await mkdir('data', { recursive: true });
  await writeFile(OUT, JSON.stringify(out, null, 1));
  console.log(`Wrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
