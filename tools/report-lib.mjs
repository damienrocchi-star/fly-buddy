// Parsing helpers for fishing reports. No Node- or browser-specific APIs, so the same code
// runs in the GitHub Action (tools/fetch-reports.mjs) and in browser tests.

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  hellip: '…', ndash: '–', mdash: '—', deg: '°', frac12: '½', raquo: '»', laquo: '«', copy: '©', reg: '®', trade: '™',
};

export function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+\d*);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
}

const unCdata = (s) => String(s || '').replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');

export function stripHtml(html) {
  let s = unCdata(html);
  if (/&lt;\/?[a-z]/i.test(s)) s = decodeEntities(s); // HTML that was escaped inside the feed
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
  return decodeEntities(s).replace(/\s+/g, ' ').trim();
}

// HTML page -> list of visible text lines (block elements become line breaks).
export function htmlToLines(html) {
  const s = String(html || '')
    .replace(/<(script|style|head|noscript)[\s\S]*?<\/\1>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|td|th|section|article|table|ul|ol|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(s).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

export function clip(text, max = 300) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 30)).replace(/[\s,;:–-]+$/, '') + '…';
}

const tag = (block, name) => {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? m[1] : '';
};

// RSS 2.0 or Atom -> [{ title, date (ISO), url, excerpt }], newest first.
// full: true also returns `full`, the whole post text when the feed includes it (for keyword scanning only).
export function parseFeed(xml, { limit = 5, skip = null, maxLen = 300, full = false } = {}) {
  const blocks = String(xml).match(/<item\b[\s\S]*?<\/item>/gi) || String(xml).match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  const skipRe = skip ? new RegExp(skip, 'i') : null;
  const items = blocks.map((b) => {
    let url = stripHtml(tag(b, 'link'));
    if (!url) {
      const alt = /<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i.exec(b) || /<link\b[^>]*href=["']([^"']+)["']/i.exec(b);
      url = alt ? decodeEntities(alt[1]) : '';
    }
    const rawDate = stripHtml(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date'));
    const d = new Date(rawDate);
    let text = stripHtml(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content:encoded') || tag(b, 'content'));
    // WordPress adds "[…] The post X appeared first on Y." to excerpts.
    text = text.replace(/\s*The post .{0,200}? appeared first on .{0,120}$/i, '').replace(/\s*\[(…|\.\.\.)\]\s*$/, '…').trim();
    if (skipRe) text = text.replace(skipRe, '').trim();
    const item = { title: stripHtml(tag(b, 'title')), date: isNaN(d) ? null : d.toISOString(), url, excerpt: clip(text, maxLen) };
    if (full) item.full = stripHtml(tag(b, 'content:encoded') || tag(b, 'content') || tag(b, 'description') || tag(b, 'summary'));
    return item;
  }).filter((x) => x.title && x.url);
  items.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return items.slice(0, limit);
}

// A site's RSS/Atom feed from its HTML <link rel="alternate">, skipping comment feeds.
export function discoverFeed(html, pageUrl) {
  const re = /<link\b[^>]*>/gi;
  let m;
  while ((m = re.exec(String(html)))) {
    const t = m[0];
    if (!/rel=["']alternate["']/i.test(t) || !/type=["']application\/(rss|atom)\+xml["']/i.test(t)) continue;
    const href = /href=["']([^"']+)["']/i.exec(t);
    if (!href || /comments|sitemap/i.test(href[1]) || /comments/i.test(t)) continue;
    try { return new URL(decodeEntities(href[1]), pageUrl).href; } catch (e) { /* ignore bad URLs */ }
  }
  return null;
}

// Michigan DNR weekly report bulletin -> [{ region, place, text }].
const DNR_REGIONS = ['Southeast Lower Peninsula', 'Southwest Lower Peninsula', 'Northeast Lower Peninsula',
  'Northwest Lower Peninsula', 'Upper Peninsula'];
const DNR_OTHER = /^(Great Lakes Temperature Map|Weekly Fishing Tip|Fishing tip:?.*|Daily Streamflow Conditions|Marked and tagged fish|Share or view as webpage|Update preferences|Visit us on our website:?.*)$/i;

export function parseDnr(html) {
  const lines = htmlToLines(html);
  const sections = [];
  let region = null, cur = null;
  const close = () => { if (cur && cur.text.trim()) sections.push({ ...cur, text: cur.text.trim() }); cur = null; };
  for (const line of lines) {
    if (DNR_REGIONS.includes(line)) { close(); region = line; continue; }
    if (/^Back to top$/i.test(line) || DNR_OTHER.test(line)) { close(); if (DNR_OTHER.test(line)) region = null; continue; }
    const place = /^([A-Z][A-Za-z.'’ &/-]{1,45}?)\s*:\s*(.*)$/.exec(line);
    if (region && place && !/https?$/i.test(place[1])) {
      close();
      cur = { region, place: place[1].trim(), text: place[2] || '' };
      continue;
    }
    if (cur) cur.text += (cur.text ? ' ' : '') + line;
  }
  close();
  return sections;
}
