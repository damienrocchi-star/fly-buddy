// Tiny key-value store. Everything stays on the phone.
// Uses IndexedDB (room for photos). If that's unavailable or doesn't respond
// (some private-browsing modes), falls back to localStorage, then to memory.
const DB = 'fly-buddy', STORE = 'kv', PREFIX = 'fly-buddy:';
const mem = new Map();
let dbp;

function db() {
  if (!dbp) dbp = new Promise((res) => {
    const timer = setTimeout(() => res(null), 3000);
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => { clearTimeout(timer); res(r.result); };
      r.onerror = () => { clearTimeout(timer); res(null); };
    } catch (e) { clearTimeout(timer); res(null); }
  });
  return dbp;
}

const ls = {
  get(key) {
    try { const v = localStorage.getItem(PREFIX + key); return v == null ? undefined : JSON.parse(v); } catch (e) { return mem.get(key); }
  },
  set(key, val) {
    try { localStorage.setItem(PREFIX + key, JSON.stringify(val)); } catch (e) { mem.set(key, val); }
  },
};

export async function get(key, fallback = null) {
  const d = await db();
  if (!d) { const v = ls.get(key); return v === undefined ? fallback : v; }
  return new Promise((res) => {
    try {
      const q = d.transaction(STORE).objectStore(STORE).get(key);
      q.onsuccess = () => res(q.result === undefined ? fallback : q.result);
      q.onerror = () => res(fallback);
    } catch (e) { res(fallback); }
  });
}

export async function set(key, val) {
  const d = await db();
  if (!d) return ls.set(key, val);
  return new Promise((res) => {
    try {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(val, key);
      tx.oncomplete = () => res();
      tx.onerror = () => { ls.set(key, val); res(); };
    } catch (e) { ls.set(key, val); res(); }
  });
}

// Ask the browser not to clear our data when space is low.
export function persist() {
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}
