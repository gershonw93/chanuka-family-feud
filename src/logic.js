// Pure game helpers: answer matching, survey grouping, ids.

export const rid = () => Math.random().toString(36).slice(2, 10);
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
export const makeCode = () =>
  Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");

export const clean = (s, max = 40) =>
  String(s ?? "").replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g, "").replace(/\s+/g, " ").trim().slice(0, max);

const STOP = new Set(["a", "an", "the", "my", "his", "her", "their", "some", "of", "to", "and"]);

function singular(w) {
  if (w.length <= 3) return w;
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (/(ches|shes|sses|xes|zes|oes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) return w.slice(0, -1);
  return w;
}

export function norm(s) {
  const words = String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9֐-׿ ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const kept = words.filter((w) => !STOP.has(w));
  return (kept.length ? kept : words).map(singular).join(" ").trim();
}

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Two normalized answers count as the same answer (close spellings, plurals).
export function similar(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const A = a.replace(/ /g, ""), B = b.replace(/ /g, "");
  if (A === B) return true;
  const L = Math.max(A.length, B.length);
  const allowed = L <= 3 ? 0 : L <= 7 ? 1 : 2;
  return lev(A, B) <= allowed;
}

// Looser check for a guess against a board answer: also allows a whole-word match inside.
export function guessMatches(guess, answer) {
  const g = norm(guess), a = norm(answer);
  if (!g || !a) return false;
  if (similar(g, a)) return true;
  if (a.length >= 4 && ` ${g} `.includes(` ${a} `)) return true;
  if (g.length >= 4 && ` ${a} `.includes(` ${g} `)) return true;
  return false;
}

// Group survey answers and rank by how many people gave each. 10 points per person.
export function buildSurveyBoard(texts, max = 7) {
  const groups = [];
  texts.forEach((raw, order) => {
    const t = clean(raw, 32);
    const n = norm(t);
    if (!n) return;
    let g = groups.find((x) => similar(x.key, n));
    if (!g) {
      g = { key: n, count: 0, order, spell: {} };
      groups.push(g);
    }
    g.count++;
    const k = t.toLowerCase();
    g.spell[k] = g.spell[k] || { t, c: 0 };
    g.spell[k].c++;
  });
  groups.sort((x, y) => y.count - x.count || x.order - y.order);
  return groups.slice(0, max).map((g) => {
    const best = Object.values(g.spell).sort((x, y) => y.c - x.c)[0].t;
    return { t: best.charAt(0).toUpperCase() + best.slice(1), p: g.count * 10, n: g.count, r: false };
  });
}

// How well a typed answer matches a board answer: 3 same answer, 2 one contains the other,
// 1 they share a meaningful word, 0 no match.
const KEYSTOP = new Set([...STOP, "with", "for", "on", "in", "at", "it", "is", "your", "you", "they", "them", "that", "this", "too", "very", "all", "out", "up", "get", "who", "what", "when", "something", "thing", "stuff", "people", "everyone", "someone"]);
export function matchScore(guess, answer) {
  const g = norm(guess), a = norm(answer);
  if (!g || !a) return 0;
  if (similar(g, a)) return 3;
  if (a.length >= 4 && ` ${g} `.includes(` ${a} `)) return 2;
  if (g.length >= 4 && ` ${a} `.includes(` ${g} `)) return 2;
  const words = (s) => s.split(" ").filter((w) => w.length >= 4 && !KEYSTOP.has(w));
  const aw = words(a);
  for (const w of words(g)) if (aw.some((x) => similar(w, x))) return 1;
  return 0;
}

// Index of the best-matching card for a typed answer, or -1.
export function bestCard(board, guess) {
  let best = -1, score = 0;
  board.forEach((c, i) => {
    const sc = matchScore(guess, c.t);
    if (sc > score) { score = sc; best = i; }
  });
  return best;
}
