// Aggregation over the existing endpoints. Records, medal tables and pilot pages are computed here
// from the per-course boards (the server has no /records endpoint, and /pilots only knows claimed
// callsigns), so every callsign on a board gets a page.
// The fan-out is bounded: only course hashes that /courses says have at least
// one time are fetched (a handful on prod today), BOARD_CONCURRENCY at a time, memoized per tab.

import { api, cached, allowed } from "./api.js";

const S = () => window.FinsSite;
const BOARD_LIMIT = 100;
const BOARD_CONCURRENCY = 4;

/** {list, byId, byHash} over /courses/catalog. */
export function catalog(signal) {
  return cached("d:catalog", 300000, async () => {
    const list = await api.catalog({ signal });
    const byId = new Map(), byHash = new Map();
    for (const c of list) { byId.set(c.course_id, c); byHash.set(c.course_hash, c); }
    return { list, byId, byHash };
  });
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/** Every raced course's full board: {boards: {hash: rows}, courses: {hash: {course_id,
 * course_name, cup, current}}, raced: /courses rows}. A course whose hash is not the catalog's
 * current one (it was edited since) is kept, marked current:false, under its old name. */
export function allBoards(signal) {
  return cached("d:boards", 60000, async () => {
    const [cat, raced] = await Promise.all([catalog(signal), api.courses({ signal })]);
    const boards = {}, courses = {};
    await pool(raced, BOARD_CONCURRENCY, async (r) => {
      const rows = await api.leaderboard(r.course_hash, BOARD_LIMIT, { signal });
      const cur = cat.byHash.get(r.course_hash);
      boards[r.course_hash] = rows;
      courses[r.course_hash] = {
        course_id: r.course_id, course_name: cur ? cur.course_name : r.course_name,
        cup: cur ? cur.cup : r.cup, current: !!cur,
      };
    });
    return { boards, courses, raced, cat };
  });
}

export function recentRaces(signal) {
  return api.racesRecent(100, { signal });
}

/** The current-version board for a catalog course id (or null when nobody has raced it). */
export async function boardForCourse(courseId, signal) {
  const cat = await catalog(signal);
  const c = cat.byId.get(courseId);
  if (!c) return { course: null, rows: [] };
  const raced = await api.courses({ signal });
  const hit = raced.find((r) => r.course_hash === c.course_hash);
  const rows = hit ? await api.leaderboard(c.course_hash, BOARD_LIMIT, { signal }) : [];
  return { course: c, rows };
}

/** {hash: record_ms} for the catalog's current hashes, from /courses (no fan-out). */
export async function recordIndex(signal) {
  const raced = await api.courses({ signal });
  const m = new Map();
  for (const r of raced) m.set(r.course_hash, r);
  return m;
}

/** Joke-plane assignment for the pilot card: MODEL_BASE index.json + assignments.json, fetched
 * the way race.js fetches them. Needs the target CSP (raw.githubusercontent.com); resolves to
 * null when blocked, and the card falls back to the model on the pilot's latest run. */
export function modelsIndex(base) {
  return cached("d:models", 600000, async () => {
    try {
      if (!(await allowed("connect-src", base + "index.json"))) return null;
      const [idx, asn] = await Promise.all([
        fetch(base + "index.json", { credentials: "omit" }).then((r) => (r.ok ? r.json() : [])),
        fetch(base + "assignments.json", { credentials: "omit" }).then((r) => (r.ok ? r.json() : {})),
      ]);
      const byId = {};
      for (const m of Array.isArray(idx) ? idx : []) if (m && m.id) byId[m.id] = m;
      return { byId, assignments: asn && typeof asn === "object" ? asn : {} };
    } catch (_) {
      return null;
    }
  });
}

export function nameFor(boardsCourses, hash) {
  const c = boardsCourses[hash];
  return c ? S().parseCourseName(c.course_name).title : hash;
}
