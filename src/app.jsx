import { QUESTIONS } from "./questions.js";
import { rid, makeCode, clean, guessMatches, buildSurveyBoard, bestCard } from "./logic.js";
import { makeSupabaseDb } from "./supabase-db.js";

const { useState, useEffect, useRef, useMemo, useCallback } = React;

/* ------------------------------------------------------------------ */
/* Small platform helpers                                              */
/* ------------------------------------------------------------------ */

const store = (kind) => ({
  get(k) { try { return window[kind].getItem(k); } catch (e) { return null; } },
  set(k, v) { try { window[kind].setItem(k, v); } catch (e) {} },
  del(k) { try { window[kind].removeItem(k); } catch (e) {} },
});
const local = store("localStorage");
const session = store("sessionStorage");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (o) => JSON.parse(JSON.stringify(o));

function myPid() {
  let p = session.get("lf-pid");
  if (!p) { p = "p" + rid(); session.set("lf-pid", p); }
  return p;
}

/* ------------------------------------------------------------------ */
/* Sound: tiny synth, no files                                         */
/* ------------------------------------------------------------------ */

const Sound = {
  ctx: null,
  on: local.get("lf-sound") !== "off",
  ensure() {
    try {
      if (!this.ctx) {
        const C = window.AudioContext || window.webkitAudioContext;
        if (C) this.ctx = new C();
      }
      if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
    } catch (e) {}
    return this.ctx;
  },
  tone(freq, dur, type = "sine", vol = 0.25, when = 0, to) {
    if (!this.on) return;
    const c = this.ensure();
    if (!c) return;
    const t = c.currentTime + when;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.05);
  },
  ding() { this.tone(988, 0.9, "triangle", 0.4); this.tone(1480, 1.1, "sine", 0.25, 0.09); this.tone(1976, 0.7, "sine", 0.12, 0.18); },
  flip() { this.tone(523, 0.12, "square", 0.1); this.tone(784, 0.18, "triangle", 0.22, 0.07); this.tone(1047, 0.35, "triangle", 0.2, 0.14); },
  strike() { this.tone(150, 0.7, "sawtooth", 0.28, 0, 110); this.tone(155, 0.7, "square", 0.12, 0, 112); },
  win() { [523, 659, 784, 1047, 784, 1047].forEach((f, i) => this.tone(f, 0.3, "triangle", 0.25, i * 0.11)); },
  fanfare() { [392, 523, 659, 784, 659, 784, 1047].forEach((f, i) => this.tone(f, i === 6 ? 1.2 : 0.28, "triangle", 0.28, i * 0.16)); },
  tick() { this.tone(1200, 0.05, "square", 0.05); },
  buzz() { this.tone(330, 0.25, "square", 0.2, 0, 440); },
};

/* ------------------------------------------------------------------ */
/* Game model (the host screen owns and writes this document)          */
/* ------------------------------------------------------------------ */

const TEAMS = {
  A: { name: "Team Latke", cls: "team-a" },
  B: { name: "Team Sufganiyah", cls: "team-b" },
};
const SURVEY_MS = 30000;
const fx = (kind, extra = {}) => ({ k: rid(), kind, t: Date.now(), ...extra });

function newGame(code) {
  return {
    v: 1, code, rev: 0, createdAt: Date.now(), hostTs: Date.now(),
    phase: "lobby",
    settings: { rounds: 6, mode: "teams", teamPick: "host" },
    teamNames: { A: TEAMS.A.name, B: TEAMS.B.name },
    roster: {}, assign: {}, kicked: {}, scores: {}, played: {}, usedQ: [],
    roundNo: 0, roundKey: null, question: "", source: "", fallbackQ: null,
    board: [], bank: 0, strikes: 0, control: null, controlPid: null, stealSide: null,
    face: null, buzz: null, survey: null, fx: null, last: null, sharp: [], note: "",
  };
}

const activeIds = (s) => Object.keys(s.roster || {}).filter((p) => !s.kicked?.[p]);
const teamOf = (s, pid) => s.assign?.[pid] || s.roster?.[pid]?.team || null;
const nameOf = (s, pid) => s.roster?.[pid]?.name || "Someone";
const sideOf = (s, pid) => (s.settings.mode === "teams" ? teamOf(s, pid) || "A" : pid);
const teamName = (s, t) => clean(s?.teamNames?.[t], 24) || TEAMS[t]?.name || "A team";
const sideName = (s, side) => (s.settings.mode === "teams" ? teamName(s, side) : nameOf(s, side));
function LastResult({ s }) {
  const L = s.last;
  if (!L) return null;
  if (!L.side) return <>Nobody got that one!</>;
  if (L.how === "correct") return <><span className="gold">{sideName(s, L.side)}</span> got it! <span className="gold">+{L.pts}</span></>;
  return <><span className="gold">{sideName(s, L.side)}</span> {L.how === "steal" ? "stole" : "banked"} <span className="gold">{L.pts}</span> points!</>;
}
const NAME_IDEAS = [
  "Team Latke", "Team Sufganiyah", "The Dreidel Spinners", "Gelt Getters", "Oil Be There", "The Maccabees",
  "Applesauce Army", "Sour Cream Squad", "Shamash Squad", "Eight Crazy Nights", "The Crispy Edges", "Nes Gadol",
];
function otherSide(s, side) {
  if (s.settings.mode === "teams") return side === "A" ? "B" : "A";
  const f = s.face || {};
  return side === f.p1 ? f.p2 : f.p1;
}
function sides(s) {
  if (s.settings.mode === "teams") return ["A", "B"];
  return activeIds(s);
}
function standings(s) {
  return sides(s)
    .map((side) => ({ side, name: sideName(s, side), score: s.scores?.[side] || 0 }))
    .sort((a, b) => b.score - a.score);
}

function balanceTeams(s) {
  const ids = activeIds(s);
  const count = { A: 0, B: 0 };
  ids.forEach((p) => { const t = teamOf(s, p); if (t) count[t]++; });
  ids.forEach((p) => {
    if (!teamOf(s, p)) {
      const t = count.A <= count.B ? "A" : "B";
      s.assign[p] = t;
      count[t]++;
    }
  });
}

function shuffle(a) {
  const x = a.slice();
  for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; }
  return x;
}
function leastPlayed(s, ids) {
  return shuffle(ids).sort((a, b) => (s.played[a] || 0) - (s.played[b] || 0));
}

function pickFaceoff(s) {
  const ids = activeIds(s);
  if (s.settings.mode === "teams") {
    const a = leastPlayed(s, ids.filter((p) => teamOf(s, p) === "A"));
    const b = leastPlayed(s, ids.filter((p) => teamOf(s, p) === "B"));
    if (a.length && b.length) return [a[0], b[0]];
  }
  const all = leastPlayed(s, ids);
  return [all[0] || null, all[1] || null];
}

function setupFaceoff(s) {
  const [p1, p2] = pickFaceoff(s);
  [p1, p2].forEach((p) => { if (p) s.played[p] = (s.played[p] || 0) + 1; });
  s.face = { p1, p2, stage: "ready", first: null, answering: null };
  s.buzz = { id: rid(), open: false, winner: null, times: null };
  s.phase = "faceoff";
  if (buzzMode(s) === "instant" && p1 && p2) {
    s.buzz.open = true;
    s.buzz.openedAt = Date.now();
    s.face.stage = "open";
  }
}

function pickQuestion(s) {
  let free = QUESTIONS.map((_, i) => i).filter((i) => !s.usedQ.includes(i));
  if (!free.length) { s.usedQ = []; free = QUESTIONS.map((_, i) => i); }
  const idx = free[Math.floor(Math.random() * free.length)];
  s.usedQ.push(idx);
  return idx;
}

const WEB = typeof window !== "undefined" && !!window.LF_BACKEND;
const SITE = "latke-feud.vercel.app";

const AUTO_PTS = [32, 24, 16, 11, 8, 5, 4];

// kind: "builtin" | "survey" | "custom" | "mine". opts: { text, idx, item, mode, replace }
function beginRound(s, kind, opts = {}) {
  if (!opts.replace) s.roundNo += 1;
  s.roundNo = Math.max(1, s.roundNo);
  s.roundKey = rid();
  Object.assign(s, { bank: 0, strikes: 0, control: null, controlPid: null, stealSide: null, last: null, sharp: [], note: "", typed: null, turn: null });
  let board = null;
  s.openQ = false;
  if (kind === "custom" || kind === "open") {
    s.question = clean(opts.text, 120);
    s.fallbackQ = null;
  } else if (kind === "mine") {
    const it = opts.item;
    s.question = clean(it.q, 120);
    s.fallbackQ = null;
    s.usedMine = [...(s.usedMine || []).filter((x) => x !== it.id), it.id];
    if (opts.mode !== "survey" && opts.mode !== "open" && Array.isArray(it.a) && it.a.length) {
      board = it.a.map(([t, p]) => ({ t: clean(t, 32), p: Math.max(0, Number(p) || 0), r: false }));
    }
  } else {
    let idx = opts.idx;
    if (Number.isInteger(idx) && QUESTIONS[idx]) { if (!s.usedQ.includes(idx)) s.usedQ.push(idx); }
    else idx = pickQuestion(s);
    s.question = QUESTIONS[idx].q;
    s.fallbackQ = idx;
    if (kind === "builtin" && !opts.open) board = QUESTIONS[idx].a.map(([t, p]) => ({ t, p, r: false }));
  }
  s.source = kind;
  if (board) {
    s.board = board;
    setupFaceoff(s);
  } else if (kind === "open" || opts.open || (kind === "mine" && opts.mode !== "survey")) {
    // Just ask it: straight to the buzzers, host judges the spoken answer.
    s.board = [];
    s.openQ = true;
    s.survey = null;
    setupFaceoff(s);
  } else {
    const total = (s.settings.surveySec || 30) * 1000;
    s.board = [];
    s.face = null;
    s.buzz = null;
    s.survey = { id: rid(), endsAt: Date.now() + total, total, done: false, empty: false };
    s.phase = "survey";
  }
}

// How the buzzers open: "random" (6-9 s after the question appears), "tap" (host), "instant".
const buzzMode = (s) => s.settings.buzzMode || (s.settings.autoOpen ? "instant" : "random");

// Schedule the random opening whenever a face-off is waiting for its buzzers.
function syncAutoOpen(d) {
  const f = d.face;
  if (d.phase === "faceoff" && f && f.stage === "ready" && f.p1 && f.p2 && buzzMode(d) === "random") {
    if (!f.autoAt) f.autoAt = Date.now() + 6000 + Math.floor(Math.random() * 3000);
  } else if (f && f.autoAt) {
    delete f.autoAt;
  }
}

const membersOf = (s, side) => (s.settings.mode === "teams" ? activeIds(s).filter((p) => teamOf(s, p) === side) : [side]);

// The one player who types the steal answer: the stealing side's face-off player.
function stealCaptain(d) {
  if (!d.stealSide) return null;
  if (d.settings.mode !== "teams") return d.stealSide;
  const f = d.face || {};
  const fromFace = [f.p1, f.p2].find((p) => p && !d.kicked?.[p] && teamOf(d, p) === d.stealSide);
  return fromFace || membersOf(d, d.stealSide)[0] || null;
}

// Typed answers wait for the host when the host's phone remote is connected (or the host chose that).
const reviewOn = (s) => (s.settings.judgeMode ? s.settings.judgeMode === "host" : Object.keys(s.remotes || {}).length > 0);

// The host acted on a typed answer that was waiting: record the outcome.
function resolvePending(d, verdict) {
  if (d.typed && d.typed.verdict === "pending") d.typed = { ...d.typed, verdict, k: rid() };
}

// Who may type an answer right now. A new id whenever a new answer is expected.
function syncTurn(d) {
  let pids = [];
  if (d.phase === "faceoff" && d.face && (d.face.stage === "answer1" || d.face.stage === "answer2") && d.face.answering) pids = [d.face.answering];
  else if (d.phase === "round" && d.control) pids = membersOf(d, d.control);
  else if (d.phase === "steal" && d.stealSide) { const c = stealCaptain(d); pids = c ? [c] : []; }
  if (!pids.length) { d.turn = null; return; }
  const sig = [d.roundKey, d.phase, d.face?.stage, d.face?.answering, d.control, d.stealSide, d.strikes, d.board.filter((c) => c.r).length, pids.join(",")].join("|");
  if (!d.turn || d.turn.sig !== sig) d.turn = { id: rid(), sig, pids };
}

function giveControl(s, pid) {
  s.control = sideOf(s, pid);
  s.controlPid = pid;
  s.strikes = 0;
  s.phase = "round";
  s.face.stage = "done";
  s.note = `${sideName(s, s.control)} has control`;
}

function allRevealed(s) { return s.board.length > 0 && s.board.every((c) => c.r); }

function endRound(s, side, how, players) {
  if (side) s.scores[side] = (s.scores[side] || 0) + s.bank;
  s.last = { side: side || null, pts: side ? s.bank : 0, how };
  s.phase = "roundEnd";
  s.buzz = s.buzz ? { ...s.buzz, open: false } : null;
  // Phones that guessed an answer on the board during the round
  const sharp = [];
  Object.values(players || {}).forEach((rec) => {
    if (!rec || rec.remote || s.kicked?.[rec.pid] || rec.guess?.id !== s.roundKey) return;
    if (s.board.some((c) => guessMatches(rec.guess.text, c.t))) sharp.push(nameOf(s, rec.pid));
  });
  s.sharp = sharp.slice(0, 12);
  s.fx = fx("win");
}

/* ------------------------------------------------------------------ */
/* Shared storage hooks                                                */
/* ------------------------------------------------------------------ */

function useCapabilities() {
  const [st, setSt] = useState({ loading: true, db: null, room: null });
  useEffect(() => {
    let alive = true;
    (async () => {
      const web = window.LF_BACKEND;
      if (web && web.url && web.key) {
        await sleep(0);
        if (alive) setSt({ loading: false, db: makeSupabaseDb(web.url, web.key), room: null });
        return;
      }
      for (let i = 0; i < 40 && !(window.claude && typeof window.claude.use === "function"); i++) await sleep(100);
      if (!(window.claude && typeof window.claude.use === "function")) {
        if (alive) setSt({ loading: false, db: null, room: null });
        return;
      }
      const [db, room] = await Promise.all([
        window.claude.use("db").catch(() => null),
        window.claude.use("room").catch(() => null),
      ]);
      if (alive) setSt({ loading: false, db, room });
    })();
    return () => { alive = false; };
  }, []);
  return st;
}

// One write in flight per document; always sends the newest value.
function useWriter(ref, onError) {
  const q = useRef({ busy: false, pending: null });
  return useCallback((value) => {
    q.current.pending = value;
    if (q.current.busy || !ref) return;
    q.current.busy = true;
    (async () => {
      while (q.current.pending) {
        const v = q.current.pending;
        q.current.pending = null;
        try {
          await ref.set({ ...v, hostTs: Date.now() });
          onError && onError(null);
        } catch (e) {
          const code = e?.code || "unavailable";
          onError && onError(code);
          if (code === "unavailable" || code === "resource_exhausted") {
            await sleep(code === "unavailable" ? 500 + Math.random() * 500 : 1500);
            if (!q.current.pending) q.current.pending = v;
          }
        }
      }
      q.current.busy = false;
    })();
  }, [ref]);
}

// Phones: follow the room document. Live snapshot plus polling (1 s, or 300 ms when fast).
function useRoomState(db, code, fast) {
  const [state, setState] = useState(null);
  const [status, setStatus] = useState("loading");
  const best = useRef(null);
  const offset = useRef(null);
  const accept = useCallback((snap) => {
    if (!snap) return;
    if (!snap.exists) {
      if (!best.current && !snap.metadata?.fromCache) setStatus("missing");
      return;
    }
    const d = snap.data();
    if (!d) return;
    if (!snap.metadata?.fromCache && typeof d.hostTs === "number") {
      const o = d.hostTs - Date.now();
      if (offset.current === null || o > offset.current) offset.current = o;
    }
    if (!best.current || (d.rev || 0) > (best.current.rev || 0)) {
      best.current = d;
      setState(d);
      setStatus("ok");
    }
  }, []);
  useEffect(() => {
    if (!db || !code) return;
    best.current = null;
    setState(null);
    setStatus("loading");
    const ref = db.doc("rooms/" + code);
    const timer = setTimeout(() => { if (!best.current) setStatus((s) => (s === "loading" ? "slow" : s)); }, 10000);
    const unsub = ref.onSnapshot(accept, () => {});
    return () => { clearTimeout(timer); unsub(); };
  }, [db, code, accept]);
  useEffect(() => {
    if (!db || !code) return;
    const ref = db.doc("rooms/" + code);
    let alive = true;
    (async () => {
      while (alive) {
        try { accept(await ref.get()); }
        catch (e) { if (e?.code === "resource_exhausted") await sleep(3000); }
        await sleep(fast ? 300 : 1000);
      }
    })();
    return () => { alive = false; };
  }, [db, code, fast, accept]);
  const hostNow = useCallback(() => Date.now() + (offset.current || 0), []);
  return { state, status, hostNow };
}

// Host: collect every phone's record (db docs, plus room presence as a backup channel).
function usePlayers(db, room, code, fast) {
  const [players, setPlayers] = useState({});
  const map = useRef({});
  const mergeRec = useCallback((rec) => {
    if (!rec || typeof rec.pid !== "string" || !/^p[a-z0-9]{4,12}$/.test(rec.pid)) return false;
    const cur = map.current[rec.pid];
    if (cur && (cur.v || 0) >= (rec.v || 0)) return false;
    map.current = { ...map.current, [rec.pid]: rec };
    return true;
  }, []);
  const acceptMany = useCallback((recs) => {
    let changed = false;
    recs.forEach((r) => { if (mergeRec(r)) changed = true; });
    if (changed) setPlayers(map.current);
  }, [mergeRec]);
  const fastRef = useRef(fast);
  fastRef.current = fast;
  useEffect(() => {
    if (!db || !code) return;
    const col = db.collection("rooms/" + code + "/players");
    const unsub = col.onSnapshot((qs) => acceptMany(qs.docs.map((d) => d.data())), () => {});
    let alive = true;
    (async () => {
      while (alive) {
        try { const qs = await col.get(); acceptMany(qs.docs.map((d) => d.data())); }
        catch (e) { if (e?.code === "resource_exhausted") await sleep(3000); }
        await sleep(fastRef.current ? 300 : 1000);
      }
    })();
    return () => { alive = false; unsub(); };
  }, [db, code, acceptMany]);
  useEffect(() => {
    if (!room || !code) return;
    const read = (peers) => acceptMany(peers.map((p) => (p.presence?.ff?.code === code ? p.presence.ff.rec : null)).filter(Boolean));
    const unsub = room.onPeers((ch) => read(ch.peers), () => {});
    return () => unsub();
  }, [room, code, acceptMany]);
  return players;
}

/* ------------------------------------------------------------------ */
/* Visual pieces                                                       */
/* ------------------------------------------------------------------ */

function Menorah({ lit = 0, size = "md" }) {
  const n = Math.max(0, Math.min(8, lit));
  const candles = [];
  for (let i = 0; i < 9; i++) {
    const shamash = i === 4;
    // light from the right, as candles are added each night
    const pos = i < 4 ? i : i - 1;
    const on = shamash ? n > 0 : 7 - pos < n;
    candles.push(
      <div key={i} className={"candle" + (shamash ? " shamash" : "") + (on ? " on" : "")}>
        <span className="flame" />
      </div>
    );
  }
  return (
    <div className={"menorah " + size} aria-label={`${n} of 8 candles lit`}>
      <div className="candles">{candles}</div>
      <div className="menorah-base" />
    </div>
  );
}

function Btn({ children, onClick, kind = "gold", className = "", disabled, big, ...rest }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => { Sound.ensure(); onClick && onClick(e); }}
      className={`btn btn-${kind} ${big ? "btn-big" : ""} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

function BoardCard({ i, card, onTap, canTap, host }) {
  const revealed = card.r;
  return (
    <button
      type="button"
      className={`card ${revealed ? "revealed" : ""} ${card.late ? "late" : ""} ${canTap && !revealed ? "tappable" : ""}`}
      onClick={() => canTap && !revealed && onTap(i)}
      disabled={!canTap || revealed}
      aria-label={revealed ? `${card.t}, ${card.p} points` : host && canTap ? `Reveal answer ${i + 1}: ${card.t}` : `Answer ${i + 1}, hidden`}
    >
      <span className="card-inner">
        <span className="card-face card-front">
          <span className="card-num">{i + 1}</span>
          {host && canTap ? <span className="card-peek">{card.t}</span> : null}
        </span>
        <span className="card-face card-back">
          <span className="card-text">{card.t}</span>
          <span className="card-pts">{card.p}</span>
        </span>
      </span>
    </button>
  );
}

function Board({ board, onTap, canTap, host, peek }) {
  const two = board.length > 4;
  const rows = two ? Math.ceil(board.length / 2) : board.length;
  return (
    <div className={"board" + (two ? "" : " compact")} style={{ gridTemplateRows: `repeat(${rows}, auto)`, gridAutoFlow: two ? "column" : "row" }}>
      {board.map((c, i) => (
        <BoardCard key={i} i={i} card={c} onTap={onTap} canTap={canTap} host={host && peek} />
      ))}
    </div>
  );
}

function StrikeOverlay({ n, k }) {
  if (!n) return null;
  return (
    <div className="strike-overlay" key={k} aria-live="assertive" aria-label={`Strike ${n}`}>
      {Array.from({ length: n }).map((_, i) => (
        <span key={i} className="strike-x" style={{ animationDelay: `${i * 0.06}s` }}>✕</span>
      ))}
    </div>
  );
}

function Strikes({ n }) {
  return (
    <div className="strikes" aria-label={`${n} strikes`}>
      {[0, 1, 2].map((i) => <span key={i} className={"strike-dot" + (i < n ? " on" : "")}>✕</span>)}
    </div>
  );
}

function Confetti() {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = cv.getContext("2d");
    let w = 0, h = 0, raf = 0, parts = [];
    const colors = ["#f5c542", "#ffe58a", "#ffffff", "#5b8cff", "#2d5bd8", "#bcd3ff"];
    const resize = () => { w = cv.width = cv.clientWidth * devicePixelRatio; h = cv.height = cv.clientHeight * devicePixelRatio; };
    resize();
    window.addEventListener("resize", resize);
    const burst = () => {
      for (let i = 0; i < 140; i++) {
        parts.push({
          x: Math.random() * w, y: -20 - Math.random() * h * 0.3,
          vx: (Math.random() - 0.5) * 3 * devicePixelRatio, vy: (2 + Math.random() * 3) * devicePixelRatio,
          r: (4 + Math.random() * 6) * devicePixelRatio, a: Math.random() * 6, va: (Math.random() - 0.5) * 0.3,
          c: colors[(Math.random() * colors.length) | 0], star: Math.random() < 0.18,
        });
      }
    };
    const star = (x, y, r) => {
      for (let t = 0; t < 2; t++) {
        ctx.beginPath();
        for (let k = 0; k < 3; k++) {
          const ang = (Math.PI * 2 * k) / 3 + (t ? Math.PI : 0) - Math.PI / 2;
          const px = x + Math.cos(ang) * r, py = y + Math.sin(ang) * r;
          k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();
      }
    };
    burst();
    const iv = setInterval(burst, 2600);
    const step = () => {
      ctx.clearRect(0, 0, w, h);
      parts = parts.filter((p) => p.y < h + 40);
      parts.forEach((p) => {
        p.x += p.vx; p.y += p.vy; p.a += p.va; p.vx *= 0.995;
        ctx.save();
        if (p.star) {
          ctx.strokeStyle = p.c; ctx.lineWidth = 2 * devicePixelRatio;
          star(p.x, p.y, p.r * 1.4);
        } else {
          ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.fillStyle = p.c;
          ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2);
        }
        ctx.restore();
      });
      raf = requestAnimationFrame(step);
    };
    step();
    return () => { cancelAnimationFrame(raf); clearInterval(iv); window.removeEventListener("resize", resize); };
  }, []);
  return <canvas ref={ref} className="confetti" aria-hidden="true" />;
}

function SoundToggle() {
  const [on, setOn] = useState(Sound.on);
  return (
    <button
      type="button"
      className="chip"
      onClick={() => { Sound.on = !on; setOn(!on); local.set("lf-sound", !on ? "on" : "off"); if (!on) { Sound.ensure(); Sound.flip(); } }}
      aria-pressed={on}
    >
      {on ? "🔊 Sound on" : "🔇 Sound off"}
    </button>
  );
}

function Countdown({ endsAt, now, big, total = SURVEY_MS }) {
  const [, force] = useState(0);
  useEffect(() => { const t = setInterval(() => force((x) => x + 1), 200); return () => clearInterval(t); }, []);
  const left = Math.max(0, Math.ceil((endsAt - now()) / 1000));
  const frac = Math.max(0, Math.min(1, (endsAt - now()) / total));
  return (
    <div className={"countdown" + (big ? " big" : "")}>
      <div className="count-num">{left}</div>
      <div className="count-bar"><span style={{ width: `${frac * 100}%` }} /></div>
    </div>
  );
}

function ErrorScreen({ title, children }) {
  return (
    <div className="screen center">
      <div className="panel max-w-xl">
        <h1 className="display text-4xl mb-4 text-[var(--gold)]">{title}</h1>
        <div className="space-y-3 text-lg leading-relaxed">{children}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Landing                                                             */
/* ------------------------------------------------------------------ */

function Landing({ db, onHost, onResume, onJoin, onPrep, onRemote }) {
  const [rcode, setRcode] = useState("");
  const [rpin, setRpin] = useState("");
  const [rerr, setRerr] = useState("");
  const hashCode = (location.hash || "").replace("#", "").toUpperCase();
  const [code, setCode] = useState(/^[A-Z]{4}$/.test(hashCode) ? hashCode : local.get("lf-last-code") || "");
  const [name, setName] = useState(local.get("lf-name") || "");
  const [err, setErr] = useState("");
  const resumeCode = local.get("lf-host-code");


  const submit = (e) => {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    const n = clean(name, 20);
    if (!/^[A-Z]{4}$/.test(c)) { setErr("The room code is the 4 letters on the TV screen."); return; }
    if (!n) { setErr("Type your name so everyone knows who buzzed."); return; }
    local.set("lf-name", n);
    onJoin(c, n);
  };

  return (
    <div className="screen landing">
      <div className="landing-inner">
        <div className="text-center">
          <Menorah lit={8} size="lg" />
          <h1 className="display title">Latke Feud</h1>
          <p className="tagline">The family says… and the family is never wrong.</p>
          <div className="flex flex-wrap gap-2 justify-center mt-3">
            <a className="chip" href="#join-panel" onClick={(e) => { e.preventDefault(); document.getElementById("join-code")?.focus(); }}>I'm a player</a>
            <a className="chip chip-on" href="#remote" onClick={(e) => { e.preventDefault(); document.getElementById("remote")?.scrollIntoView({ behavior: "smooth" }); setTimeout(() => document.getElementById("remote-code")?.focus(), 400); }}>I'm the host: phone remote</a>
          </div>
          {!WEB && (
            <p className="site-note">
              Party night: the TV and every phone should open <b>https://{SITE}</b>. Games hosted here on claude.ai can only be joined from this claude.ai link.
            </p>
          )}
        </div>

        <form className="panel join-panel" onSubmit={submit}>
          <h2 className="display text-3xl text-[var(--gold)]">Join on your phone</h2>
          <label className="field">
            <span>Room code</span>
            <input id="join-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4))}
              placeholder="ABCD" autoComplete="off" autoCapitalize="characters" inputMode="text" className="input code-input" />
          </label>
          <label className="field">
            <span>Your name</span>
            <input id="join-name" value={name} onChange={(e) => setName(e.target.value.slice(0, 20))} placeholder="Cousin Dana" autoComplete="nickname" className="input" />
          </label>
          {err && <p className="err" role="alert">{err}</p>}
          <button type="submit" className="btn btn-gold btn-big w-full" onClick={() => Sound.ensure()}>Join</button>
        </form>

        <div className="panel host-panel">
          <h2 className="display text-3xl text-white">Host on the big screen</h2>
          <p className="muted">Open this on the TV or laptop everyone can see. You'll get a room code for the phones.</p>
          <div className="flex flex-wrap gap-3">
            <Btn kind="blue" big onClick={onHost}>Host a new game</Btn>
            <Btn kind="gold" onClick={onPrep}>Prepare questions</Btn>
            {resumeCode && <Btn kind="ghost" onClick={() => onResume(resumeCode)}>Resume game {resumeCode}</Btn>}
          </div>
        </div>
          <form id="remote" className="panel remote-panel" onSubmit={(e) => {
            e.preventDefault();
            const c = rcode.trim().toUpperCase();
            if (!/^[A-Z]{4}$/.test(c) || !/^\d{4}$/.test(rpin.trim())) { setRerr("Type the 4-letter room code and the 4-digit PIN from Host tools on the TV."); return; }
            onRemote(c, rpin.trim());
          }}>
            <h2 className="display text-3xl text-[var(--gold)]">Host remote</h2>
            <p className="muted">For the host only: see the answers and run the game from your phone. Get the PIN from ⚙ Host tools on the TV.</p>
            <div className="flex flex-wrap gap-2">
              <input id="remote-code" className="input remote-in" value={rcode} onChange={(e) => setRcode(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4))} placeholder="Code" autoComplete="off" aria-label="Room code" />
              <input id="remote-pin" className="input remote-in" value={rpin} inputMode="numeric" onChange={(e) => setRpin(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))} placeholder="PIN" autoComplete="off" aria-label="Host PIN" />
              <button type="submit" className="btn btn-ghost">Host remote</button>
            </div>
            {rerr && <p className="err">{rerr}</p>}
          </form>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Host screen                                                         */
/* ------------------------------------------------------------------ */

function Host({ db, room, code, initial, onExit }) {
  const [s, setS] = useState(initial);
  const sRef = useRef(initial);
  const undoStack = useRef([]);
  const [syncErr, setSyncErr] = useState(null);
  const [xs, setXs] = useState(null);
  const [custom, setCustom] = useState("");
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [peek, setPeek] = useState(local.get("lf-peek") === "on");
  const [toolsOpen, setToolsOpen] = useState(false);
  const setId = useMemo(getSetId, []);
  const [library, saveLibrary, libErr, libLoaded, setup] = useLibrary(db, setId);
  const docRef = useMemo(() => db.doc("rooms/" + code), [db, code]);
  const write = useWriter(docRef, setSyncErr);
  const fast = (s.phase === "faceoff" && s.face?.stage === "open") || Object.keys(s.remotes || {}).length > 0;
  const players = usePlayers(db, room, code, fast);
  const playersRef = useRef(players);
  playersRef.current = players;

  useEffect(() => { local.set("lf-host-code", code); write(sRef.current); }, []);

  const commit = useCallback((fn, opts = {}) => {
    const prev = sRef.current;
    const next = clone(prev);
    fn(next);
    syncAutoOpen(next);
    syncTurn(next);
    next.rev = (prev.rev || 0) + 1;
    if (!opts.noUndo) {
      undoStack.current.push(prev);
      if (undoStack.current.length > 40) undoStack.current.shift();
    }
    sRef.current = next;
    setS(next);
    write(next);
  }, [write]);

  const undo = () => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    const next = clone(prev);
    next.rev = (sRef.current.rev || 0) + 1;
    next.roster = clone(sRef.current.roster);
    next.kicked = clone(sRef.current.kicked);
    next.assign = clone(sRef.current.assign);
    next.remotes = clone(sRef.current.remotes || {});
    next.lastCmd = clone(sRef.current.lastCmd || {});
    sRef.current = next;
    setS(next);
    write(next);
  };

  // Sounds and strike overlay follow the effect stamp in state.
  const played = useRef(new Set(initial.fx ? [initial.fx.k] : []));
  useEffect(() => {
    const f = s.fx;
    if (!f || played.current.has(f.k)) return;
    played.current.add(f.k);
    if (f.kind === "strike") { setXs({ n: f.n || 1, k: f.k }); setTimeout(() => setXs((x) => (x && x.k === f.k ? null : x)), 1400); }
    if (Sound[f.kind]) Sound[f.kind]();
  }, [s.fx]);

  // Keep the roster in the shared state in step with the phones.
  useEffect(() => {
    const cur = sRef.current;
    const updates = {}, leaving = [], back = [];
    Object.values(players).forEach((rec) => {
      if (!rec || rec.code !== code || rec.remote) return;
      const k = cur.kicked[rec.pid];
      if (rec.left) { if (cur.roster[rec.pid] && !k) leaving.push([rec.pid, rec.v || 1]); return; }
      if (k) { if ((rec.v || 0) > k) back.push(rec.pid); else return; }
      const name = clean(rec.name, 20) || "Someone";
      const team = rec.team === "A" || rec.team === "B" ? rec.team : null;
      const have = cur.roster[rec.pid];
      if (!have || have.name !== name || (have.team || null) !== team) updates[rec.pid] = { name, team, at: have?.at || Date.now() };
    });
    if (!Object.keys(updates).length && !leaving.length && !back.length) return;
    commit((d) => {
      Object.assign(d.roster, updates);
      leaving.forEach(([p, v]) => { d.kicked[p] = v; });
      back.forEach((p) => { delete d.kicked[p]; });
      if (d.phase !== "lobby" && d.settings.mode === "teams") balanceTeams(d);
    }, { noUndo: true });
  }, [players]);

  // Clock: survey timer and buzz resolution.
  const buzzSeen = useRef({ id: null, first: 0 });
  const doneTurns = useRef(new Set());
  const lastTick = useRef(0);
  useEffect(() => {
    const iv = setInterval(() => {
      const st = sRef.current;
      if (st.phase === "survey" && st.survey && !st.survey.done) {
        const left = st.survey.endsAt - Date.now();
        const sec = Math.ceil(left / 1000);
        if (left > 0 && sec <= 5 && sec !== lastTick.current) { lastTick.current = sec; Sound.tick(); }
        if (left <= 0) finishSurvey();
      }
      if (st.phase === "faceoff" && st.face?.stage === "ready" && st.face.autoAt && Date.now() >= st.face.autoAt) {
        commit((d) => {
          if (d.phase !== "faceoff" || d.face?.stage !== "ready") return;
          d.buzz = { id: rid(), open: true, openedAt: Date.now(), winner: null, times: null };
          d.face.stage = "open";
          d.note = "";
        });
      }
      if (st.phase === "faceoff" && st.face?.stage === "open" && st.buzz?.open) {
        const presses = [st.face.p1, st.face.p2].map((pid) => {
          const r = playersRef.current[pid];
          return r && r.buzz && r.buzz.id === st.buzz.id && typeof r.buzz.at === "number" ? { pid, at: r.buzz.at } : null;
        }).filter(Boolean);
        if (presses.length) {
          const b = buzzSeen.current;
          if (b.id !== st.buzz.id) { b.id = st.buzz.id; b.first = Date.now(); }
          if (presses.length === 2 || Date.now() - b.first > 700) {
            presses.sort((x, y) => x.at - y.at);
            declareBuzz(presses[0].pid, presses);
          }
        }
      }
      const t = st.turn;
      if (t && t.id && !st.openQ && !doneTurns.current.has(t.id)) {
        const cands = (t.pids || []).map((pid) => {
          const r = playersRef.current[pid];
          return r && r.answer && r.answer.id === t.id && clean(r.answer.text) ? { pid, text: r.answer.text, at: r.answer.at || 0 } : null;
        }).filter(Boolean).sort((a, b) => a.at - b.at);
        if (cands.length) { doneTurns.current.add(t.id); judgeTyped(t.id, cands[0].pid, cands[0].text); }
      }
    }, 150);
    return () => clearInterval(iv);
  }, []);

  /* ---- actions ---- */

  const declareBuzz = (pid, presses) => commit((d) => {
    if (d.phase !== "faceoff" || !d.face || (d.face.stage !== "open" && d.face.stage !== "ready")) return;
    d.buzz.open = false;
    d.buzz.winner = pid;
    d.buzz.times = presses ? Object.fromEntries(presses.map((p) => [p.pid, p.at])) : null;
    d.face.stage = "answer1";
    d.face.answering = pid;
    d.fx = fx("ding");
  });

  const openBuzzers = () => commit((d) => {
    d.buzz = { id: rid(), open: true, openedAt: Date.now(), winner: null, times: null };
    d.face.stage = "open";
    d.note = "";
  });

  const resetBuzzers = () => commit((d) => {
    d.buzz = { id: rid(), open: false, winner: null, times: null };
    d.face.stage = "ready";
    d.face.first = null;
    d.face.answering = null;
  });

  const swapSlot = (slot) => commit((d) => {
    const f = d.face;
    const cur = f[slot];
    const other = slot === "p1" ? f.p2 : f.p1;
    let pool = activeIds(d).filter((p) => p !== other);
    if (d.settings.mode === "teams" && cur) {
      const t = teamOf(d, cur);
      const same = pool.filter((p) => teamOf(d, p) === t);
      if (same.length > 1) pool = same;
    }
    if (pool.length < 2 && cur) return;
    pool.sort((a, b) => (d.roster[a]?.at || 0) - (d.roster[b]?.at || 0));
    const next = pool[(pool.indexOf(cur) + 1) % pool.length];
    if (cur) d.played[cur] = Math.max(0, (d.played[cur] || 1) - 1);
    d.played[next] = (d.played[next] || 0) + 1;
    f[slot] = next;
    d.buzz = { id: rid(), open: false, winner: null, times: null };
    f.stage = "ready";
  });

  const faceAnswerD = (d, idx) => {
    resolvePending(d, idx >= 0 && d.board[idx] && !d.board[idx].r ? "hit" : "miss");
    const f = d.face;
    const pid = f.answering;
    let pts = 0;
    if (idx >= 0 && d.board[idx] && !d.board[idx].r) {
      d.board[idx].r = true;
      pts = d.board[idx].p;
      d.bank += pts;
      d.fx = fx("flip");
    } else {
      idx = -1;
      d.fx = fx("strike", { n: 1 });
    }
    if (f.stage === "answer1") {
      // Any answer on the board wins control for the buzzer's side.
      if (idx >= 0 || allRevealed(d)) { giveControl(d, pid); if (allRevealed(d)) endRound(d, d.control, "cleared", playersRef.current); return; }
      f.first = { pid, idx, pts };
      f.answering = pid === f.p1 ? f.p2 : f.p1;
      f.stage = "answer2";
      d.note = `Not on the board! ${nameOf(d, f.answering)}, your turn.`;
    } else if (f.stage === "answer2") {
      const first = f.first || { pts: 0, idx: -1 };
      if (first.idx < 0 && idx < 0) {
        f.stage = "ready";
        f.first = null;
        f.answering = null;
        d.buzz = { id: rid(), open: false, winner: null, times: null };
        d.note = "Both missed. Buzz again!";
        return;
      }
      const winner = pts > first.pts ? pid : first.pid;
      giveControl(d, winner);
      if (allRevealed(d)) endRound(d, d.control, "cleared", playersRef.current);
    }
  };
  const faceAnswer = (idx) => commit((d) => faceAnswerD(d, idx));

  // Board-free rounds: the host judges the spoken answer.
  const judge = (correct) => commit((d) => {
    const f = d.face;
    if (!f || !f.answering) return;
    const pid = f.answering;
    if (correct) {
      d.bank = d.settings.openPts || 10;
      endRound(d, sideOf(d, pid), "correct", playersRef.current);
      return;
    }
    d.fx = fx("strike", { n: 1 });
    if (f.stage === "answer1") {
      f.first = { pid, idx: -1, pts: 0 };
      f.answering = pid === f.p1 ? f.p2 : f.p1;
      f.stage = "answer2";
      d.note = `${nameOf(d, f.answering)}, your turn!`;
    } else {
      f.stage = "ready";
      f.first = null;
      f.answering = null;
      d.buzz = { id: rid(), open: false, winner: null, times: null };
      d.note = "Both missed. Buzz again, or move on.";
    }
  });
  // A phone typed its answer: compare it with the hidden cards and play it.
  const typedUndo = useRef(null);
  const judgeTyped = (turnId, pid, text) => {
    const before = sRef.current;
    judgeTypedCommit(turnId, pid, text);
    const now = sRef.current;
    if (now !== before && now.typed && now.typed.k !== before.typed?.k) typedUndo.current = { k: now.typed.k, len: undoStack.current.length };
  };
  const canOverride = !!(s.typed && typedUndo.current && typedUndo.current.k === s.typed.k && typedUndo.current.len === undoStack.current.length);
  const overrideTyped = () => {
    if (!canOverride) return;
    const t = s.typed;
    typedUndo.current = null;
    undo();
    commit((d) => { d.typed = { ...t, verdict: "override", k: rid() }; }, { noUndo: true });
  };
  const judgeTypedCommit = (turnId, pid, text) => commit((d) => {
    if (!d.turn || d.turn.id !== turnId || d.openQ) return;
    const idx = bestCard(d.board, text);
    const dup = idx >= 0 && d.board[idx].r;
    if (reviewOn(d)) {
      // Wait for the host: show the answer and the app's suggestion, change nothing yet.
      d.typed = { name: nameOf(d, pid), text: clean(text, 40), verdict: "pending", suggest: dup ? -1 : idx, dupOf: dup ? idx : -1, k: rid() };
      return;
    }
    d.typed = { name: nameOf(d, pid), text: clean(text, 40), verdict: idx < 0 ? "miss" : dup ? "dup" : "hit", k: rid() };
    if (d.phase === "faceoff") faceAnswerD(d, dup ? -1 : idx);
    else if (d.phase === "round") { if (idx >= 0 && !dup) roundRevealD(d, idx); else roundStrikeD(d); }
    else if (d.phase === "steal") stealAnswerD(d, dup ? -1 : idx);
  });

  const nobodyGotIt = () => commit((d) => { d.bank = 0; endRound(d, null, "none", playersRef.current); d.fx = fx("strike", { n: 1 }); });

  const roundRevealD = (d, idx) => {
    if (!d.board[idx] || d.board[idx].r) return;
    resolvePending(d, "hit");
    d.board[idx].r = true;
    d.bank += d.board[idx].p;
    d.fx = fx("flip");
    if (allRevealed(d)) endRound(d, d.control, "cleared", playersRef.current);
  };
  const roundReveal = (idx) => commit((d) => roundRevealD(d, idx));

  const roundStrikeD = (d) => {
    resolvePending(d, "miss");
    d.strikes += 1;
    d.fx = fx("strike", { n: d.strikes });
    if (d.strikes >= 3) {
      d.phase = "steal";
      d.stealSide = otherSide(d, d.control);
      d.note = `${sideName(d, d.stealSide)} can steal with one answer`;
    }
  };
  const roundStrike = () => commit((d) => roundStrikeD(d));

  const passControl = () => commit((d) => {
    d.control = otherSide(d, d.control);
    d.controlPid = null;
    d.note = `${sideName(d, d.control)} has control`;
  });

  const stealAnswerD = (d, idx) => {
    resolvePending(d, idx >= 0 && d.board[idx] && !d.board[idx].r ? "hit" : "miss");
    if (idx >= 0 && d.board[idx] && !d.board[idx].r) {
      d.board[idx].r = true;
      d.bank += d.board[idx].p;
      endRound(d, d.stealSide, "steal", playersRef.current);
    } else {
      endRound(d, d.control, "held", playersRef.current);
      d.fx = fx("strike", { n: 1 });
    }
  };
  const stealAnswer = (idx) => commit((d) => stealAnswerD(d, idx));

  // Play a card for whatever answer is expected right now.
  const playCardD = (d, idx) => {
    if (d.phase === "faceoff" && d.face && (d.face.stage === "answer1" || d.face.stage === "answer2") && !d.openQ) faceAnswerD(d, idx);
    else if (d.phase === "round") { if (idx >= 0) roundRevealD(d, idx); else roundStrikeD(d); }
    else if (d.phase === "steal") stealAnswerD(d, idx);
  };
  const acceptPending = () => commit((d) => {
    const t = d.typed;
    if (!t || t.verdict !== "pending" || !(t.suggest >= 0)) return;
    playCardD(d, t.suggest);
  });

  // After a round: flip the answers nobody found, one at a time.
  const revealLate = (i) => commit((d) => {
    if ((d.phase !== "roundEnd" && d.phase !== "pick") || !d.board[i] || d.board[i].r) return;
    d.board[i].r = true;
    d.board[i].late = true;
    d.fx = fx("flip");
  }, { noUndo: true });
  const revealTimer = useRef(null);
  const revealRest = () => {
    clearInterval(revealTimer.current);
    const step = () => {
      const st = sRef.current;
      const i = st.board.findIndex((c) => !c.r);
      if (st.phase !== "roundEnd" || i < 0) { clearInterval(revealTimer.current); return; }
      revealLate(i);
    };
    step();
    revealTimer.current = setInterval(step, 1300);
  };
  useEffect(() => () => clearInterval(revealTimer.current), []);

  const finishSurvey = (force) => commit((d) => {
    if (d.phase !== "survey" || !d.survey || (d.survey.done && !force)) return;
    const texts = Object.values(playersRef.current)
      .filter((r) => r && !d.kicked[r.pid] && r.survey?.id === d.survey.id && clean(r.survey.text))
      .sort((a, b) => (a.survey.at || 0) - (b.survey.at || 0))
      .map((r) => r.survey.text);
    const board = buildSurveyBoard(texts);
    if (!board.length) { d.survey.done = true; d.survey.empty = true; return; }
    d.survey.done = true;
    d.survey.count = texts.length;
    d.board = board;
    d.fx = fx("ding");
    setupFaceoff(d);
  }, { noUndo: true });

  const extendSurvey = () => commit((d) => {
    d.survey = { ...d.survey, endsAt: Math.max(Date.now(), d.survey.endsAt) + 15000, done: false, empty: false };
  }, { noUndo: true });

  const useBuiltInBoard = () => commit((d) => {
    d.board = QUESTIONS[d.fallbackQ].a.map(([t, p]) => ({ t, p, r: false }));
    d.source = "builtin";
    setupFaceoff(d);
  });

  const startGame = () => commit((d) => {
    if (d.settings.mode === "teams") balanceTeams(d);
    d.scores = {};
    d.played = {};
    d.roundNo = 0;
    d.phase = "pick";
    d.fx = fx("fanfare");
  });

  const nextMine = library.find((it) => !(s.usedMine || []).includes(it.id));
  const nextRound = (kind) => {
    if ((kind === "custom" || kind === "open") && !clean(custom, 120)) return;
    if (kind === "mine" && !nextMine) return;
    commit((d) => beginRound(d, kind, { text: custom, item: nextMine }));
    if (kind === "custom" || kind === "open") setCustom("");
  };

  /* ---- host overrides ---- */
  const live = s.phase === "faceoff" || s.phase === "round" || s.phase === "steal" || s.phase === "survey";
  const act = {
    adjustScore: (side, delta) => commit((d) => { d.scores[side] = (d.scores[side] || 0) + delta; }),
    giveControlTo: (side) => commit((d) => {
      d.control = side;
      d.controlPid = null;
      d.stealSide = null;
      d.phase = "round";
      if (d.face) { d.face.stage = "done"; if (!d.face.p1 || !d.face.p2) d.face = { ...d.face }; }
      if (d.buzz) d.buzz.open = false;
      if (d.strikes >= 3) d.strikes = 0;
      d.note = `${sideName(d, side)} has control`;
    }),
    awardBank: (side) => commit((d) => endRound(d, side, "host", playersRef.current)),
    revealFree: (i) => commit((d) => { if (d.board[i] && !d.board[i].r) { d.board[i].r = true; d.board[i].late = true; d.fx = fx("flip"); } }),
    setStrikes: (n) => commit((d) => {
      d.strikes = n;
      if (d.phase === "steal") { d.phase = "round"; d.stealSide = null; }
    }),
    skipRound: () => commit((d) => {
      d.roundNo = Math.max(0, d.roundNo - 1);
      Object.assign(d, { phase: "pick", board: [], face: null, buzz: null, survey: null, last: null, bank: 0, strikes: 0, question: "", control: null, stealSide: null, note: "" });
    }),
    setFace: (slot, pid) => commit((d) => {
      if (d.phase !== "faceoff" || !d.face) return;
      const other = slot === "p1" ? "p2" : "p1";
      if (d.face[other] === pid) d.face[other] = d.face[slot];
      d.face[slot] = pid;
      d.face.stage = "ready";
      d.face.first = null;
      d.face.answering = null;
      d.buzz = { id: rid(), open: false, winner: null, times: null };
    }),
    playQuestion: (choice, mode) => commit((d) => {
      const replace = d.phase === "faceoff" || d.phase === "round" || d.phase === "steal" || d.phase === "survey";
      if (choice.kind === "mine") beginRound(d, "mine", { item: choice.item, mode, replace });
      else beginRound(d, mode === "survey" ? "survey" : "builtin", { idx: choice.idx, replace, open: mode === "open" });
    }),
    setRounds: (n) => commit((d) => { d.settings.rounds = Math.max(Math.max(1, d.roundNo), Math.min(30, n)); }, { noUndo: true }),
    setSurveySec: (n) => commit((d) => { d.settings.surveySec = n; }, { noUndo: true }),
    setOpenPts: (n) => commit((d) => { d.settings.openPts = n; }, { noUndo: true }),
    setBuzzMode: (v) => commit((d) => { d.settings.buzzMode = v; }, { noUndo: true }),
    setJudgeMode: (v) => commit((d) => { d.settings.judgeMode = v; }, { noUndo: true }),
    movePlayer: (pid) => commit((d) => { d.assign[pid] = teamOf(d, pid) === "A" ? "B" : "A"; }),
    kick: (pid) => commit((d) => { d.kicked[pid] = playersRef.current[pid]?.v || Date.now(); }),
  };

  const finishGame = () => commit((d) => {
    d.phase = "final";
    d.fx = fx("fanfare");
    d.board.forEach((c) => { c.r = true; });
  });

  const playAgain = () => commit((d) => {
    Object.assign(d, { phase: "lobby", scores: {}, played: {}, roundNo: 0, board: [], bank: 0, strikes: 0, face: null, buzz: null, survey: null, last: null, sharp: [], note: "", question: "" });
  });

  const movePlayer = (pid) => commit((d) => {
    const t = teamOf(d, pid);
    d.assign[pid] = t === "A" ? "B" : "A";
  }, { noUndo: true });

  const kick = (pid) => commit((d) => { d.kicked[pid] = playersRef.current[pid]?.v || Date.now(); }, { noUndo: true });

  // A new game starts with the host's prepared setup (team names, rounds, mode).
  useEffect(() => {
    const cur = sRef.current;
    if (!libLoaded || cur.setupApplied || cur.phase !== "lobby" || cur.roundNo !== 0) return;
    commit((d) => {
      d.teamNames = { A: setup.teamA, B: setup.teamB };
      d.settings.rounds = setup.rounds;
      d.settings.mode = setup.mode;
      d.setupApplied = true;
    }, { noUndo: true });
  }, [libLoaded, setup]);

  /* ---- host remote (the host's own phone) ---- */
  const pin = useMemo(() => {
    const k = "lf-pin-" + code;
    let p = local.get(k);
    if (!/^\d{4}$/.test(p || "")) { p = String(1000 + Math.floor(Math.random() * 9000)); local.set(k, p); }
    return p;
  }, [code]);
  const runCmd = (c) => {
    const st = sRef.current;
    const answering = st.phase === "faceoff" && st.face && (st.face.stage === "answer1" || st.face.stage === "answer2");
    switch (c.type) {
      case "tap": {
        const i = Number(c.arg);
        if (!st.board[i] || st.board[i].r) break;
        if (st.phase === "roundEnd") revealLate(i);
        else if (answering && !st.openQ) faceAnswer(i);
        else if (st.phase === "round") roundReveal(i);
        else if (st.phase === "steal") stealAnswer(i);
        break;
      }
      case "strike":
        if (answering) { if (st.openQ) judge(false); else faceAnswer(-1); }
        else if (st.phase === "round") roundStrike();
        else if (st.phase === "steal") stealAnswer(-1);
        break;
      case "correct": if (answering && st.openQ) judge(true); break;
      case "open": if (st.phase === "faceoff" && st.face?.stage === "ready" && st.face.p1 && st.face.p2) openBuzzers(); break;
      case "reset": if (st.phase === "faceoff") resetBuzzers(); break;
      case "override": overrideTyped(); break;
      case "accept": acceptPending(); break;
      case "reveal": revealLate(Number(c.arg)); break;
      case "revealRest": revealRest(); break;
      case "pass": if (st.phase === "round") passControl(); break;
      case "nobody": if (st.phase === "faceoff" && st.openQ) nobodyGotIt(); break;
      case "start": if (st.phase === "lobby" && activeIds(st).length >= 2) startGame(); break;
      case "next":
        if (st.phase !== "pick" && st.phase !== "roundEnd") break;
        if (c.arg === "ask") { const q = clean(c.text, 120); if (q) commit((d) => beginRound(d, "open", { text: q })); }
        else if (c.arg === "mine") { if (nextMine) commit((d) => beginRound(d, "mine", { item: nextMine })); }
        else if (c.arg === "builtin" || c.arg === "survey") commit((d) => beginRound(d, c.arg, {}));
        break;
      case "closeSurvey": if (st.phase === "survey") finishSurvey(true); break;
      case "extend": if (st.phase === "survey") extendSurvey(); break;
      case "finish": if (st.phase !== "lobby" && st.phase !== "final") finishGame(); break;
      case "again": if (st.phase === "final") playAgain(); break;
      case "undo": undo(); break;
      default: break;
    }
  };
  useEffect(() => {
    const good = Object.values(players).filter((r) => r && r.remote && r.code === code && String(r.pin) === pin);
    const cur = sRef.current;
    const fresh = good.filter((r) => !(cur.remotes || {})[r.pid]);
    if (fresh.length) {
      commit((d) => { d.remotes = { ...(d.remotes || {}) }; fresh.forEach((r) => { d.remotes[r.pid] = true; }); }, { noUndo: true });
      return;
    }
    for (const r of good) {
      const c = r.cmd;
      if (!c || typeof c.id !== "string" || (cur.lastCmd || {})[r.pid] === c.id) continue;
      commit((d) => { d.lastCmd = { ...(d.lastCmd || {}), [r.pid]: c.id }; }, { noUndo: true });
      runCmd(c);
      break;
    }
  }, [players, s.rev]);

  /* ---- render ---- */

  const ids = activeIds(s);
  const isTeams = s.settings.mode === "teams";

  const header = (
    <header className="host-header">
      <div className="flex items-center gap-4 min-w-0">
        <span className="display brand">Latke Feud</span>
        {s.phase !== "lobby" && <span className="round-pill">Round {Math.max(1, s.roundNo)} of {s.settings.rounds}</span>}
      </div>
      <Menorah lit={s.phase === "lobby" ? 0 : s.roundNo} size="sm" />
      <div className="flex items-center gap-2 flex-wrap justify-end">
        <span className="code-pill" aria-label={`Room code ${code}`}>Code <b>{code}</b></span>
        <SoundToggle />
        <button type="button" className="chip" aria-pressed={peek} title="Faint answer hints on hidden cards, for the host"
          onClick={() => { setPeek(!peek); local.set("lf-peek", peek ? "off" : "on"); }}>{peek ? "Hints on" : "Hints off"}</button>
        <button type="button" className="chip chip-tools" onClick={() => setToolsOpen(true)}>⚙ Host tools</button>
        <button type="button" className="chip" onClick={undo} disabled={!undoStack.current.length}>↶ Undo</button>
        {s.phase !== "lobby" && s.phase !== "final" && (
          confirmEnd
            ? <><button type="button" className="chip chip-warn" onClick={() => { setConfirmEnd(false); finishGame(); }}>End game now?</button><button type="button" className="chip" onClick={() => setConfirmEnd(false)}>Keep playing</button></>
            : <button type="button" className="chip" onClick={() => setConfirmEnd(true)}>End game</button>
        )}
      </div>
      {toolsOpen && ReactDOM.createPortal(
        <HostTools s={s} act={act} live={live} library={library} saveLibrary={saveLibrary} libErr={libErr} pin={pin} code={code} onClose={() => setToolsOpen(false)} />,
        document.body
      )}
    </header>
  );

  const syncBanner = syncErr && (
    <div className="sync-banner" role="alert">
      {syncErr === "invalid_argument"
        ? "This screen can't save the game. Host from the account that published this game, or ask them to share it with you with edit access."
        : syncErr === "quota_exceeded"
          ? "The game's shared storage is full. Start a new game to keep playing."
          : "Having trouble reaching shared storage. Retrying…"}
    </div>
  );

  if (s.phase === "lobby") {
    const byTeam = (t) => ids.filter((p) => teamOf(s, p) === t);
    const unplaced = ids.filter((p) => !teamOf(s, p));
    const PlayerChip = ({ pid }) => (
      <li className="player-chip">
        <button type="button" className="player-name" onClick={() => isTeams && s.settings.teamPick === "host" && movePlayer(pid)}
          title={isTeams && s.settings.teamPick === "host" ? "Tap to move to the other team" : undefined}>
          {nameOf(s, pid)}
        </button>
        <button type="button" className="player-x" aria-label={`Remove ${nameOf(s, pid)}`} onClick={() => kick(pid)}>×</button>
      </li>
    );
    return (
      <div className="screen host">
        {header}
        {syncBanner}
        <main className="lobby">
          <section className="lobby-code">
            <p className="eyebrow">{WEB ? "Grab your phone and go to" : "Grab your phone and open this same claude.ai link"}</p>
            {WEB && <p className="join-url">{SITE}</p>}
            <div className="big-code" aria-label={`Room code ${code.split("").join(" ")}`}>
              {code.split("").map((ch, i) => <span key={i} style={{ animationDelay: `${i * 0.12}s` }}>{ch}</span>)}
            </div>
            <p className="lobby-steps">Tap <b>Join</b>, type the code and your name.</p>
            <p className="muted mt-4">{ids.length} {ids.length === 1 ? "player" : "players"} joined</p>
          </section>
          <section className="lobby-side">
            <div className="settings">
              <div className="setting">
                <span className="setting-label">Rounds</span>
                <div className="stepper">
                  <button type="button" onClick={() => commit((d) => { d.settings.rounds = Math.max(1, d.settings.rounds - 1); }, { noUndo: true })} aria-label="Fewer rounds">−</button>
                  <b>{s.settings.rounds}</b>
                  <button type="button" onClick={() => commit((d) => { d.settings.rounds = Math.min(15, d.settings.rounds + 1); }, { noUndo: true })} aria-label="More rounds">+</button>
                </div>
              </div>
              <div className="setting">
                <span className="setting-label">Play as</span>
                <div className="seg">
                  <button type="button" className={isTeams ? "on" : ""} onClick={() => commit((d) => { d.settings.mode = "teams"; }, { noUndo: true })}>Two teams</button>
                  <button type="button" className={!isTeams ? "on" : ""} onClick={() => commit((d) => { d.settings.mode = "solo"; }, { noUndo: true })}>Everyone for themselves</button>
                </div>
              </div>
              {isTeams && (
                <div className="setting">
                  <span className="setting-label">Teams</span>
                  <div className="seg">
                    <button type="button" className={s.settings.teamPick === "host" ? "on" : ""} onClick={() => commit((d) => { d.settings.teamPick = "host"; }, { noUndo: true })}>I'll assign</button>
                    <button type="button" className={s.settings.teamPick === "phones" ? "on" : ""} onClick={() => commit((d) => { d.settings.teamPick = "phones"; d.assign = {}; }, { noUndo: true })}>Phones pick</button>
                  </div>
                </div>
              )}
            </div>

            {isTeams ? (
              <div className="team-cols">
                {["A", "B"].map((t) => (
                  <div key={t} className={"team-col " + TEAMS[t].cls}>
                    <div className="team-name-row">
                      <input id={"team-name-" + t} className="team-name-input display" value={s.teamNames?.[t] ?? TEAMS[t].name} maxLength={24}
                        aria-label={`Name for team ${t === "A" ? "one" : "two"}`}
                        onChange={(e) => { const v = e.target.value.slice(0, 24); commit((d) => { d.teamNames = { ...(d.teamNames || {}), [t]: v }; }, { noUndo: true }); }}
                        onBlur={() => { if (!clean(s.teamNames?.[t], 24)) commit((d) => { d.teamNames = { ...(d.teamNames || {}), [t]: TEAMS[t].name }; }, { noUndo: true }); }} />
                      <button type="button" className="dice" title="Suggest a team name" aria-label="Suggest a team name"
                        onClick={() => commit((d) => {
                          const taken = [teamName(d, "A"), teamName(d, "B")];
                          const pool = NAME_IDEAS.filter((n) => !taken.includes(n));
                          d.teamNames = { ...(d.teamNames || {}), [t]: pool[Math.floor(Math.random() * pool.length)] };
                        }, { noUndo: true })}>🎲</button>
                    </div>
                    <ul>{byTeam(t).map((p) => <PlayerChip key={p} pid={p} />)}</ul>
                    {!byTeam(t).length && <p className="muted text-sm">Nobody yet</p>}
                  </div>
                ))}
                {unplaced.length > 0 && (
                  <div className="team-col unplaced">
                    <h3 className="display">{s.settings.teamPick === "host" ? "Tap a name to place" : "Still choosing"}</h3>
                    <ul>
                      {unplaced.map((p) => (
                        <li key={p} className="player-chip">
                          <span className="player-name">{nameOf(s, p)}</span>
                          {s.settings.teamPick === "host" && <>
                            <button type="button" className="mini a" onClick={() => commit((d) => { d.assign[p] = "A"; }, { noUndo: true })}>{teamName(s, "A")}</button>
                            <button type="button" className="mini b" onClick={() => commit((d) => { d.assign[p] = "B"; }, { noUndo: true })}>{teamName(s, "B")}</button>
                          </>}
                        </li>
                      ))}
                    </ul>
                    {s.settings.teamPick === "host" && <button type="button" className="chip mt-2" onClick={() => commit((d) => balanceTeams(d), { noUndo: true })}>Split them evenly</button>}
                  </div>
                )}
              </div>
            ) : (
              <ul className="solo-list">{ids.map((p) => <PlayerChip key={p} pid={p} />)}</ul>
            )}
            {library.length > 0 && (
              <div className="prepared">
                <span><b>{library.length}</b> prepared {library.length === 1 ? "question" : "questions"} ready</span>
                {s.settings.rounds !== library.length && <button type="button" className="chip" onClick={() => commit((d) => { d.settings.rounds = Math.min(30, library.length); }, { noUndo: true })}>Play {library.length} {library.length === 1 ? "round" : "rounds"}</button>}
                <button type="button" className="chip" onClick={() => setToolsOpen(true)}>Edit</button>
              </div>
            )}
            <div className="flex flex-wrap gap-3 items-center mt-auto pt-4">
              <Btn big onClick={startGame} disabled={ids.length < 2}>Start the game</Btn>
              {ids.length < 2 && <span className="muted">Waiting for at least 2 players</span>}
              <button type="button" className="chip ml-auto" onClick={onExit}>Leave</button>
            </div>
          </section>
        </main>
      </div>
    );
  }

  // Scores column(s)
  const st = standings(s);
  const ScoreBox = ({ side }) => (
    <div className={"score-box " + (isTeams ? TEAMS[side].cls : "") + (s.control === side && (s.phase === "round" || s.phase === "steal") ? " in-control" : "") + (s.stealSide === side && s.phase === "steal" ? " stealing" : "")}>
      <div className="score-name">{sideName(s, side)}</div>
      <div className="score-num">{s.scores[side] || 0}</div>
      {isTeams && <div className="score-members">{ids.filter((p) => teamOf(s, p) === side).map((p) => nameOf(s, p)).join(" · ")}</div>}
    </div>
  );

  const canTapBoard =
    (s.phase === "faceoff" && (s.face?.stage === "answer1" || s.face?.stage === "answer2")) ||
    s.phase === "round" || s.phase === "steal" || s.phase === "roundEnd";
  const onTapCard = (i) => {
    if (s.phase === "roundEnd") revealLate(i);
    else if (s.phase === "faceoff") faceAnswer(i);
    else if (s.phase === "round") roundReveal(i);
    else if (s.phase === "steal") stealAnswer(i);
  };

  let controls = null;
  let status = null;
  if (s.phase === "pick" || s.phase === "roundEnd") {
    const last = s.roundNo >= s.settings.rounds;
    status = s.phase === "roundEnd" && s.last ? (
      <div className="status-big">
        <LastResult s={s} />
        {s.sharp?.length > 0 && <div className="sharp">Sharp guessers on the phones: {s.sharp.join(", ")}</div>}
      </div>
    ) : <div className="status-big">Get ready for round {s.roundNo + 1}!</div>;
    const hiddenLeft = s.phase === "roundEnd" ? s.board.filter((c) => !c.r).length : 0;
    controls = hiddenLeft > 0 ? (
      <div className="flex gap-3 flex-wrap items-center">
        <span className="note">{hiddenLeft} {hiddenLeft === 1 ? "answer" : "answers"} nobody found. Tap a card to show it.</span>
        <Btn big onClick={revealRest}>Reveal the rest</Btn>
        <Btn kind="ghost" onClick={() => commit((d) => { d.board.forEach((c) => { if (!c.r) { c.r = true; c.late = true; } }); }, { noUndo: true })}>Skip</Btn>
      </div>
    ) : last && s.phase === "roundEnd" ? (
      <Btn big onClick={finishGame}>Crown the winner</Btn>
    ) : (
      <div className="pick-row">
        <span className="pick-label">Round {s.roundNo + 1}:</span>
        {library.length > 0 && <Btn big onClick={() => nextRound("mine")} disabled={!nextMine}>My next question{nextMine ? ` (${library.filter((it) => !(s.usedMine || []).includes(it.id)).length} left)` : "s all played"}</Btn>}
        <form className="custom-q" onSubmit={(e) => { e.preventDefault(); nextRound("open"); }}>
          <input id="custom-q" className="input" value={custom} maxLength={120} onChange={(e) => setCustom(e.target.value)} placeholder="Type a question to ask…" />
          <button type="submit" className="btn btn-gold" disabled={!clean(custom)}>Ask it</button>
        </form>
        <Btn kind="blue" onClick={() => nextRound("builtin")}>Ready-made board</Btn>
        <Btn kind="ghost" onClick={() => nextRound("survey")}>Family survey</Btn>
      </div>
    );
  } else if (s.phase === "survey") {
    const count = Object.values(players).filter((r) => r && !s.kicked[r.pid] && r.survey?.id === s.survey?.id && clean(r.survey.text)).length;
    status = s.survey?.empty ? (
      <div className="status-big">No answers came in yet.</div>
    ) : (
      <div className="survey-status">
        <p className="eyebrow">Family survey · answer on your phone</p>
        <Countdown endsAt={s.survey.endsAt} now={Date.now} total={s.survey.total || SURVEY_MS} big />
        <p className="status-mid">{count} of {ids.length} answers in</p>
      </div>
    );
    controls = s.survey?.empty ? (
      <div className="flex gap-3 flex-wrap">
        <Btn big onClick={extendSurvey}>Give them 15 more seconds</Btn>
        {s.fallbackQ !== null && <Btn kind="blue" big onClick={useBuiltInBoard}>Use the ready-made board</Btn>}
      </div>
    ) : (
      <div className="flex gap-3 flex-wrap">
        <Btn kind="blue" onClick={() => finishSurvey(true)} disabled={!count}>Close the survey now</Btn>
        <Btn kind="ghost" onClick={extendSurvey}>+15 seconds</Btn>
      </div>
    );
  } else if (s.phase === "faceoff") {
    const f = s.face;
    const Slot = ({ slot }) => {
      const pid = f[slot];
      const won = s.buzz?.winner === pid;
      const lost = s.buzz?.winner && !won;
      const pressed = pid && players[pid]?.buzz?.id === s.buzz?.id;
      return (
        <button type="button" className={"face-slot" + (won ? " won" : "") + (lost ? " lost" : "") + (f.answering === pid ? " answering" : "") + (isTeams && pid ? " " + TEAMS[teamOf(s, pid)]?.cls : "")}
          onClick={() => f.stage === "ready" && swapSlot(slot)} disabled={f.stage !== "ready"} title={f.stage === "ready" ? "Tap to swap in someone else" : undefined}>
          <span className="face-name">{pid ? nameOf(s, pid) : "—"}</span>
          {isTeams && pid && <span className="face-team">{teamName(s, teamOf(s, pid))}</span>}
          {f.stage === "ready" && <span className="face-hint">tap to swap</span>}
          {f.stage === "open" && <span className="face-hint">{pressed ? "pressed!" : "…"}</span>}
        </button>
      );
    };
    const diff = s.buzz?.times && Object.keys(s.buzz.times).length === 2
      ? Math.abs(Object.values(s.buzz.times)[0] - Object.values(s.buzz.times)[1]) / 1000 : null;
    status = (
      <div className="faceoff-row">
        <Slot slot="p1" />
        <div className="vs">
          {f.stage === "ready" && <span>{f.autoAt ? <span className="pulse">Get ready to buzz…</span> : "Face-off!"}</span>}
          {f.stage === "open" && <span className="pulse gold">Buzzers open!</span>}
          {(f.stage === "answer1" || f.stage === "answer2") && s.buzz?.winner && (
            <div className="buzz-result">
              <div className="buzz-first"><span className="gold">{nameOf(s, s.buzz.winner)}</span> buzzed first!</div>
              <div className="locked">Buzzers locked{diff !== null && diff < 5 ? ` · by ${diff.toFixed(2)}s` : ""}</div>
            </div>
          )}
        </div>
        <Slot slot="p2" />
      </div>
    );
    if (f.stage === "ready") {
      controls = (
        <div className="flex gap-3 flex-wrap items-center">
          <Btn big onClick={openBuzzers} disabled={!f.p1 || !f.p2}>{f.autoAt ? "Open now" : "Open buzzers"}</Btn>
          {f.autoAt && <span className="note">Buzzers open by surprise in a few seconds.</span>}
          {s.note && <span className="note">{s.note}</span>}
          {s.openQ && s.note && <Btn kind="ghost" onClick={nobodyGotIt}>Nobody got it, move on</Btn>}
        </div>
      );
    } else if (f.stage === "open") {
      controls = (
        <div className="flex gap-3 flex-wrap items-center">
          <span className="note">Waiting for a buzz…</span>
          <Btn kind="ghost" onClick={resetBuzzers}>Reset buzzers</Btn>
          <span className="muted text-sm">Phone trouble? Tap who was first:</span>
          <button type="button" className="chip" onClick={() => declareBuzz(f.p1)}>{nameOf(s, f.p1)}</button>
          <button type="button" className="chip" onClick={() => declareBuzz(f.p2)}>{nameOf(s, f.p2)}</button>
        </div>
      );
    } else if (s.openQ) {
      controls = (
        <div className="flex gap-3 flex-wrap items-center">
          <span className="note"><b className="gold">{nameOf(s, f.answering)}</b>, say your answer!{(() => {
            const r = players[f.answering];
            return r?.answer?.id === s.turn?.id && clean(r?.answer?.text) ? <> Typed: <b className="gold">“{clean(r.answer.text, 40)}”</b></> : null;
          })()}</span>
          <Btn big onClick={() => judge(true)}>Correct (+{s.settings.openPts || 10})</Btn>
          <Btn kind="red" big onClick={() => judge(false)}>Wrong</Btn>
        </div>
      );
    } else {
      controls = (
        <div className="flex gap-3 flex-wrap items-center">
          <span className="note"><b className="gold">{nameOf(s, f.answering)}</b>, say it and type it on your phone. Or tap the matching card.</span>
          <Btn kind="red" big onClick={() => faceAnswer(-1)}>Not on the board</Btn>
        </div>
      );
    }
  } else if (s.phase === "round") {
    status = (
      <div className="status-big">
        <span className="gold">{sideName(s, s.control)}</span> is guessing
        <Strikes n={s.strikes} />
      </div>
    );
    controls = (
      <div className="flex gap-3 flex-wrap items-center">
        <span className="note">Phones type the answers. You can also tap a card.</span>
        <Btn kind="red" big onClick={roundStrike}>Strike</Btn>
        {s.strikes === 0 && s.board.filter((c) => c.r).length <= 1 && <Btn kind="ghost" onClick={passControl}>Pass to {sideName(s, otherSide(s, s.control))}</Btn>}
      </div>
    );
  } else if (s.phase === "steal") {
    status = (
      <div className="status-big">
        <span className="gold">{sideName(s, s.stealSide)}</span>, one guess to steal {s.bank} points!
      </div>
    );
    controls = (
      <div className="flex gap-3 flex-wrap items-center">
        <span className="note">Tap the card if they got it.</span>
        <Btn kind="red" big onClick={() => stealAnswer(-1)}>Steal missed</Btn>
      </div>
    );
  }

  if (s.phase === "final") {
    const top = st[0]?.score ?? 0;
    const winners = st.filter((x) => x.score === top);
    return (
      <div className="screen host final">
        {header}
        <Confetti />
        <main className="final-main">
          <p className="eyebrow">And the winner is…</p>
          <h1 className="display winner">{winners.map((w) => w.name).join(" & ")}</h1>
          <p className="status-mid">{top} points{winners.length > 1 ? " each. It's a tie!" : ""}</p>
          <ol className="final-list">
            {st.map((x, i) => (
              <li key={x.side} className={i === 0 || x.score === top ? "top" : ""}>
                <span>{x.name}</span><b>{x.score}</b>
              </li>
            ))}
          </ol>
          <div className="flex gap-3 flex-wrap justify-center">
            <Btn big onClick={playAgain}>Play again</Btn>
            <Btn kind="ghost" onClick={onExit}>Close game</Btn>
          </div>
        </main>
      </div>
    );
  }

  const showBoard = s.board.length > 0 && (s.phase === "faceoff" || s.phase === "round" || s.phase === "steal" || s.phase === "roundEnd");
  return (
    <div className="screen host">
      {header}
      {syncBanner}
      <StrikeOverlay n={xs?.n} k={xs?.k} />
      <main className={"game " + (isTeams ? "teams" : "solo")}>
        {isTeams && <ScoreBox side="A" />}
        <section className={"stage" + (s.openQ && s.phase === "faceoff" ? " open" : "")}>
          {s.question && s.phase !== "pick" && <h1 className="question">{s.question}</h1>}
          {s.openQ && s.phase === "faceoff" && <div className="worth">Buzz in and say your answer · worth {s.settings.openPts || 10} points</div>}
          {showBoard ? (
            <div className="board-wrap">
              <Board board={s.board} onTap={onTapCard} canTap={canTapBoard} host peek={peek} />
              {s.typed && (s.phase === "faceoff" || s.phase === "round" || s.phase === "steal" || s.phase === "roundEnd") && (
                <div className={"typed " + s.typed.verdict} key={s.typed.k}>
                  {s.typed.name} {s.typed.verdict === "pending" ? "answered" : "typed"} “{s.typed.text}”
                  <b>{s.typed.verdict === "pending" ? <span className="pulse"> … checking</span> : s.typed.verdict === "hit" ? " ✓ On the board!" : s.typed.verdict === "dup" ? " Already up there!" : s.typed.verdict === "override" ? " Host is deciding…" : " ✕ Not on the board"}</b>
                  {s.typed.verdict === "pending" && (
                    <span className="pending-btns">
                      {s.typed.suggest >= 0 && <button type="button" className="chip override" onClick={acceptPending}>✓ Accept card {s.typed.suggest + 1}</button>}
                      <button type="button" className="chip" onClick={() => commit((d) => playCardD(d, -1))}>✕ Not on the board</button>
                    </span>
                  )}
                  {canOverride && s.typed.verdict !== "pending" && <button type="button" className="chip override" onClick={overrideTyped}>Override</button>}
                  {s.typed.verdict === "override" && <span className="override-help">Tap the right card, or give a strike.</span>}
                </div>
              )}
              <div className="bank"><span>Round bank</span><b>{s.bank}</b></div>
            </div>
          ) : s.phase === "pick" || s.phase === "roundEnd" ? (
            <ScoreTable st={st} />
          ) : null}
          {s.phase === "survey" && !s.survey?.empty && (
            <div className="hidden-board">
              {Array.from({ length: 7 }).map((_, i) => <span key={i} className="ghost-card">?</span>)}
            </div>
          )}
          <div className="status">{status}</div>
        </section>
        {isTeams ? <ScoreBox side="B" /> : (
          <aside className="solo-scores">
            <h3 className="display">Scores</h3>
            <ol>
              {st.map((x) => (
                <li key={x.side} className={(s.control === x.side && (s.phase === "round" || s.phase === "steal") ? "in-control " : "") + (s.stealSide === x.side && s.phase === "steal" ? "stealing" : "")}>
                  <span>{x.name}</span><b>{x.score}</b>
                </li>
              ))}
            </ol>
          </aside>
        )}
      </main>
      {s.phase === "roundEnd" && showBoard && (
        <div className="round-scores"><ScoreTable st={st} inline /></div>
      )}
      <footer className="host-controls">{controls}</footer>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Host tools: overrides, question picker, my questions                */
/* ------------------------------------------------------------------ */

function sanitizeItems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((it) => it && typeof it.id === "string" && clean(it.q)).slice(0, 200).map((it) => ({
    id: it.id.slice(0, 20),
    q: clean(it.q, 120),
    a: Array.isArray(it.a) ? it.a.filter((r) => Array.isArray(r) && clean(r[0])).slice(0, 7).map(([t, p]) => [clean(t, 32), Math.max(0, Math.min(999, Number(p) || 0))]) : [],
  }));
}

// Each host keeps their prepared questions under a private set code saved on their device.
function getSetId() {
  let id = local.get("lf-set");
  if (!id || !/^s[a-z0-9]{8,16}$/.test(id)) {
    let r = "";
    while (r.length < 12) r += rid();
    id = "s" + r.slice(0, 12);
    local.set("lf-set", id);
  }
  return id;
}

const defaultSetup = () => ({ teamA: TEAMS.A.name, teamB: TEAMS.B.name, rounds: 6, mode: "teams" });
function cleanSetup(g) {
  const d = defaultSetup();
  if (!g || typeof g !== "object") return d;
  return {
    teamA: clean(g.teamA, 24) || d.teamA,
    teamB: clean(g.teamB, 24) || d.teamB,
    rounds: Math.max(1, Math.min(30, Math.round(Number(g.rounds) || d.rounds))),
    mode: g.mode === "solo" ? "solo" : "teams",
  };
}

function useLibrary(db, setId) {
  const [items, setItems] = useState([]);
  const [setup, setSetup] = useState(defaultSetup);
  const itemsRef = useRef([]);
  const setupRef = useRef(defaultSetup());
  const [err, setErr] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const ref = useMemo(() => db.doc("library/" + setId), [db, setId]);
  const write = useWriter(ref, setErr);
  const lastSave = useRef(0);
  useEffect(() => {
    setItems([]);
    setLoaded(false);
    const unsub = ref.onSnapshot((sn) => {
      if (Date.now() - lastSave.current < 5000) return; // don't let an older copy undo a fresh edit
      setLoaded(true);
      const its = sn.exists ? sanitizeItems(sn.data()?.items) : [];
      const g = cleanSetup(sn.exists ? sn.data()?.game : null);
      itemsRef.current = its;
      setupRef.current = g;
      setItems(its);
      setSetup(g);
    }, () => {});
    return unsub;
  }, [ref]);
  const save = useCallback((next) => {
    lastSave.current = Date.now();
    const clean2 = sanitizeItems(next);
    itemsRef.current = clean2;
    setItems(clean2);
    write({ items: clean2, game: setupRef.current });
  }, [write]);
  const saveSetup = useCallback((patch) => {
    lastSave.current = Date.now();
    const g = { ...setupRef.current, ...patch };
    setupRef.current = g;
    setSetup(g);
    write({ items: itemsRef.current, game: cleanSetup(g) });
  }, [write]);
  return [items, save, err, loaded, setup, saveSetup];
}

function Prep({ db, onBack, onHost }) {
  const [setId, setSetId] = useState(getSetId);
  const [library, save, err, loaded, setup, saveSetup] = useLibrary(db, setId);
  const [other, setOther] = useState("");
  const [msg, setMsg] = useState("");
  const switchSet = (e) => {
    e.preventDefault();
    const v = other.trim().toLowerCase();
    if (!/^s[a-z0-9]{8,16}$/.test(v)) { setMsg("That doesn't look like a set code. It starts with s and has 9 to 17 letters and numbers."); return; }
    local.set("lf-set", v);
    setSetId(v);
    setOther("");
    setMsg("Loaded that question set.");
  };
  return (
    <div className="screen prep">
      <div className="prep-inner">
        <div className="prep-head">
          <h1 className="display">Prepare your game</h1>
          <Btn kind="ghost" onClick={onBack}>Back</Btn>
        </div>
        <p className="prep-lead">Set up your game days ahead: team names, rounds, and your own questions and answers. Everything saves automatically and is still here when you come back. Players never see this screen. On party night, tap <b>Host a new game</b> on the same device, and during the game tap <b>My next question</b> to play your questions in order.</p>
        <section className="panel">
          <h2 className="display text-2xl text-[var(--gold)]">Game setup</h2>
          <div className="setup-grid">
            <label className="field">
              <span>Team 1 name</span>
              <input id="setup-team-a" className="input" value={setup.teamA} maxLength={24} onChange={(e) => saveSetup({ teamA: e.target.value })} />
            </label>
            <label className="field">
              <span>Team 2 name</span>
              <input id="setup-team-b" className="input" value={setup.teamB} maxLength={24} onChange={(e) => saveSetup({ teamB: e.target.value })} />
            </label>
          </div>
          <div className="settings">
            <div className="setting">
              <span className="setting-label">Rounds</span>
              <div className="stepper">
                <button type="button" onClick={() => saveSetup({ rounds: Math.max(1, setup.rounds - 1) })} aria-label="Fewer rounds">−</button>
                <b>{setup.rounds}</b>
                <button type="button" onClick={() => saveSetup({ rounds: Math.min(30, setup.rounds + 1) })} aria-label="More rounds">+</button>
              </div>
              {library.length > 0 && setup.rounds !== library.length && <button type="button" className="chip" onClick={() => saveSetup({ rounds: Math.min(30, library.length) })}>Match my {library.length} questions</button>}
            </div>
            <div className="setting">
              <span className="setting-label">Play as</span>
              <div className="seg">
                <button type="button" className={setup.mode === "teams" ? "on" : ""} onClick={() => saveSetup({ mode: "teams" })}>Two teams</button>
                <button type="button" className={setup.mode === "solo" ? "on" : ""} onClick={() => saveSetup({ mode: "solo" })}>Everyone for themselves</button>
              </div>
            </div>
          </div>
          <p className="muted text-sm">Saved automatically. When you host from this device, the game starts with these settings.</p>
        </section>
        <section className="panel">
          <h2 className="display text-2xl text-[var(--gold)]">Your questions {loaded ? `(${library.length})` : ""}</h2>
          <QuestionLibrary items={library} save={save} used={[]} err={err} />
        </section>
        <section className="panel">
          <h2 className="display text-xl">Your private set code</h2>
          <p>Your questions are saved under this code, and this device remembers it. To edit or host them from another device, type the code there.</p>
          <p className="set-code">{setId}</p>
          <form className="flex flex-wrap gap-2" onSubmit={switchSet}>
            <input id="set-code" className="input flex-1 min-w-[12rem]" value={other} onChange={(e) => setOther(e.target.value)} placeholder="Use a set code from another device" autoComplete="off" />
            <button type="submit" className="btn btn-ghost" disabled={!other.trim()}>Load</button>
          </form>
          {msg && <p className="flash">{msg}</p>}
        </section>
        <div className="flex flex-wrap gap-3">
          <Btn big onClick={onHost}>Host a game{library.length ? ` with these ${library.length} questions` : ""}</Btn>
          <Btn kind="ghost" onClick={onBack}>Back</Btn>
        </div>
      </div>
    </div>
  );
}

function HostTools({ s, act, live, library, saveLibrary, libErr, pin, code, onClose }) {
  const [showPin, setShowPin] = useState(false);
  const isTeams = s.settings.mode === "teams";
  const ids = activeIds(s);
  const sideList = sides(s);
  const inPlay = s.phase === "faceoff" || s.phase === "round" || s.phase === "steal";
  const [qPick, setQPick] = useState("");
  const [qMode, setQMode] = useState("open");
  const [confirmSkip, setConfirmSkip] = useState(false);
  const [flash, setFlash] = useState("");
  const done = (m) => { setFlash(m); setTimeout(() => setFlash(""), 1800); };
  useEffect(() => {
    const k = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const choice = qPick.startsWith("m:")
    ? { kind: "mine", item: library.find((it) => it.id === qPick.slice(2)) }
    : qPick.startsWith("b:") ? { kind: "builtin", idx: Number(qPick.slice(2)) } : null;
  const mineNoBoard = choice?.kind === "mine" && !(choice.item?.a?.length);
  const canPlay = choice && (choice.kind !== "mine" || choice.item) && s.phase !== "lobby" && s.phase !== "final";

  return (
    <div className="drawer-layer">
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Host tools">
        <div className="drawer-head">
          <h2 className="display">Host tools</h2>
          {flash && <span className="flash">{flash}</span>}
          <button type="button" className="chip" onClick={onClose}>Close</button>
        </div>
        <p className="muted text-sm">Everything here changes the live game for everyone. Made a mistake? Use Undo.</p>

        <section className="tool-sec remote-sec">
          <h3>Run the game from your phone</h3>
          <p className="text-sm">On your phone, open <b>{WEB ? SITE : "this same link"}</b>, and under <b>Host remote</b> enter room code <b className="gold">{code}</b> and your PIN. Your phone shows the answers and every control.</p>
          <div className="tool-row">
            {showPin
              ? <><span className="pin">{pin}</span><button type="button" className="chip" onClick={() => setShowPin(false)}>Hide PIN</button></>
              : <button type="button" className="chip chip-on" onClick={() => setShowPin(true)}>Show my PIN (turn the TV away)</button>}
            {Object.keys(s.remotes || {}).length > 0 && <span className="flash">✓ Remote connected</span>}
          </div>
        </section>

        {s.phase !== "lobby" && (
          <section className="tool-sec">
            <h3>Scores</h3>
            {sideList.map((side) => (
              <div key={side} className="tool-row score-adjust">
                <span className="tool-name">{sideName(s, side)}</span>
                <b className="tool-score">{s.scores[side] || 0}</b>
                {[-10, -1, 1, 10].map((n) => (
                  <button key={n} type="button" className="chip" onClick={() => act.adjustScore(side, n)}>{n > 0 ? "+" + n : "−" + Math.abs(n)}</button>
                ))}
              </div>
            ))}
          </section>
        )}

        {inPlay && (
          <section className="tool-sec">
            <h3>This round</h3>
            {s.phase === "faceoff" && s.face && (
              <div className="tool-row">
                <span className="tool-label">Face-off players</span>
                {["p1", "p2"].map((slot) => (
                  <select key={slot} id={"tool-face-" + slot} className="select" value={s.face[slot] || ""} onChange={(e) => act.setFace(slot, e.target.value)}>
                    {ids.map((p) => <option key={p} value={p}>{nameOf(s, p)}{isTeams ? ` (${teamName(s, teamOf(s, p))})` : ""}</option>)}
                  </select>
                ))}
              </div>
            )}
            <div className="tool-row">
              <span className="tool-label">Give control to</span>
              {sideList.map((side) => (
                <button key={side} type="button" className={"chip" + (s.control === side && s.phase !== "faceoff" ? " chip-on" : "")} onClick={() => { act.giveControlTo(side); done("Control given"); }}>{sideName(s, side)}</button>
              ))}
            </div>
            <div className="tool-row">
              <span className="tool-label">End round now, bank of {s.bank} goes to</span>
              {sideList.map((side) => (
                <button key={side} type="button" className="chip" onClick={() => { act.awardBank(side); onClose(); }}>{sideName(s, side)}</button>
              ))}
            </div>
            {s.phase !== "faceoff" && (
              <div className="tool-row">
                <span className="tool-label">Strikes</span>
                {[0, 1, 2].map((n) => (
                  <button key={n} type="button" className={"chip" + (s.strikes === n && s.phase === "round" ? " chip-on" : "")} onClick={() => act.setStrikes(n)}>{n}</button>
                ))}
              </div>
            )}
            {s.board.some((c) => !c.r) && (
              <div className="tool-row">
                <span className="tool-label">Show a card without points</span>
                {s.board.map((c, i) => !c.r && (
                  <button key={i} type="button" className="chip" onClick={() => act.revealFree(i)}>{i + 1}. {c.t}</button>
                ))}
              </div>
            )}
          </section>
        )}
        {(inPlay || s.phase === "survey") && (
          <section className="tool-sec">
            {confirmSkip
              ? <div className="tool-row"><span className="tool-label">Throw this round away? Nobody scores.</span>
                  <button type="button" className="chip chip-warn" onClick={() => { act.skipRound(); setConfirmSkip(false); onClose(); }}>Yes, skip it</button>
                  <button type="button" className="chip" onClick={() => setConfirmSkip(false)}>No</button></div>
              : <button type="button" className="chip" onClick={() => setConfirmSkip(true)}>Skip this round (no points)</button>}
          </section>
        )}

        <section className="tool-sec">
          <h3>{live ? "Switch to a different question" : "Choose the next question"}</h3>
          <select id="tool-q" className="select w-full" value={qPick} onChange={(e) => setQPick(e.target.value)}>
            <option value="">Pick a question…</option>
            {library.length > 0 && (
              <optgroup label="My questions">
                {library.map((it) => <option key={it.id} value={"m:" + it.id}>{(s.usedMine || []).includes(it.id) ? "✓ " : ""}{it.q}</option>)}
              </optgroup>
            )}
            <optgroup label="Built-in questions">
              {QUESTIONS.map((q, i) => <option key={i} value={"b:" + i}>{s.usedQ.includes(i) ? "✓ " : ""}{q.q}</option>)}
            </optgroup>
          </select>
          <div className="tool-row">
            <div className="seg">
              <button type="button" className={qMode === "open" || (qMode === "board" && mineNoBoard) ? "on" : ""} onClick={() => setQMode("open")}>Just buzz in</button>
              <button type="button" className={qMode === "board" && !mineNoBoard ? "on" : ""} disabled={mineNoBoard} onClick={() => setQMode("board")}>With its answer board</button>
              <button type="button" className={qMode === "survey" ? "on" : ""} onClick={() => setQMode("survey")}>Family survey</button>
            </div>
          </div>
          <div className="tool-row">
            <Btn onClick={() => { act.playQuestion(choice, mineNoBoard && qMode === "board" ? "open" : qMode); setQPick(""); onClose(); }} disabled={!canPlay}>
              {live ? "Switch to it now" : "Play it now"}
            </Btn>
            {s.phase === "lobby" && <span className="muted text-sm">Start the game first.</span>}
            {live && <span className="muted text-sm">Replaces the current round. Nobody scores for it.</span>}
          </div>
          <p className="muted text-sm">✓ means already played in this game.</p>
        </section>

        <section className="tool-sec">
          <h3>Game settings</h3>
          <div className="tool-row">
            <span className="tool-label">Rounds</span>
            <div className="stepper">
              <button type="button" onClick={() => act.setRounds(s.settings.rounds - 1)} aria-label="Fewer rounds">−</button>
              <b>{s.settings.rounds}</b>
              <button type="button" onClick={() => act.setRounds(s.settings.rounds + 1)} aria-label="More rounds">+</button>
            </div>
          </div>
          <div className="tool-row">
            <span className="tool-label">Points for a correct buzz-in answer</span>
            <div className="seg">
              {[5, 10, 20, 50, 100].map((n) => (
                <button key={n} type="button" className={(s.settings.openPts || 10) === n ? "on" : ""} onClick={() => act.setOpenPts(n)}>{n}</button>
              ))}
            </div>
          </div>
          <div className="tool-row">
            <span className="tool-label">Buzzers open</span>
            <div className="seg">
              <button type="button" className={buzzMode(s) === "random" ? "on" : ""} onClick={() => act.setBuzzMode("random")}>By surprise, 6 to 9 seconds after the question</button>
              <button type="button" className={buzzMode(s) === "tap" ? "on" : ""} onClick={() => act.setBuzzMode("tap")}>When I tap Open buzzers</button>
              <button type="button" className={buzzMode(s) === "instant" ? "on" : ""} onClick={() => act.setBuzzMode("instant")}>Right away</button>
            </div>
          </div>
          <div className="tool-row">
            <span className="tool-label">Typed answers</span>
            <div className="seg">
              <button type="button" className={!s.settings.judgeMode ? "on" : ""} onClick={() => act.setJudgeMode(null)}>I check them when my remote is connected</button>
              <button type="button" className={s.settings.judgeMode === "host" ? "on" : ""} onClick={() => act.setJudgeMode("host")}>Always let me check</button>
              <button type="button" className={s.settings.judgeMode === "auto" ? "on" : ""} onClick={() => act.setJudgeMode("auto")}>Always check automatically</button>
            </div>
          </div>
          <div className="tool-row">
            <span className="tool-label">Survey time</span>
            <div className="seg">
              {[15, 30, 45, 60].map((n) => (
                <button key={n} type="button" className={(s.settings.surveySec || 30) === n ? "on" : ""} onClick={() => act.setSurveySec(n)}>{n}s</button>
              ))}
            </div>
          </div>
        </section>

        {s.phase !== "lobby" && ids.length > 0 && (
          <section className="tool-sec">
            <h3>Players</h3>
            <ul className="tool-players">
              {ids.map((p) => (
                <li key={p}>
                  <span className="tool-name">{nameOf(s, p)}</span>
                  {isTeams && <button type="button" className="chip" onClick={() => act.movePlayer(p)}>Move to {teamName(s, teamOf(s, p) === "A" ? "B" : "A")}</button>}
                  <button type="button" className="chip" onClick={() => act.kick(p)}>Remove</button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="tool-sec">
          <h3>My questions</h3>
          <QuestionLibrary items={library} save={saveLibrary} used={s.usedMine || []} err={libErr} />
        </section>
      </aside>
    </div>
  );
}

const blankForm = () => ({ id: null, q: "", rows: Array.from({ length: 7 }, () => ({ t: "", p: "" })) });

function QuestionLibrary({ items, save, used, err }) {
  const [f, setF] = useState(blankForm);
  const [msg, setMsg] = useState("");
  const [del, setDel] = useState(null);
  const setRow = (i, k, v) => setF((x) => ({ ...x, rows: x.rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)) }));
  const submit = (e) => {
    e.preventDefault();
    const q = clean(f.q, 120);
    if (!q) { setMsg("Type a question first."); return; }
    const rows = f.rows.map((r) => ({ t: clean(r.t, 32), p: String(r.p).trim() === "" ? null : Math.round(Number(r.p)) })).filter((r) => r.t);
    if (rows.length === 1) { setMsg("Add at least 2 answers for a board, or leave them all empty to just buzz in."); return; }
    const auto = rows.some((r) => r.p === null || !Number.isFinite(r.p));
    const a = rows.map((r, i) => [r.t, auto ? AUTO_PTS[i] : Math.max(0, Math.min(999, r.p))]).sort((x, y) => y[1] - x[1]);
    const item = { id: f.id || "q" + rid(), q, a };
    save(f.id ? items.map((it) => (it.id === f.id ? item : it)) : [...items, item]);
    setF(blankForm());
    setMsg(f.id ? "Question updated." : "Question saved.");
  };
  const edit = (it) => {
    const rows = blankForm().rows.map((r, i) => (it.a[i] ? { t: it.a[i][0], p: String(it.a[i][1]) } : r));
    setF({ id: it.id, q: it.q, rows });
    setMsg("Editing. Save to keep your changes.");
  };
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    const next = items.slice();
    [next[i], next[j]] = [next[j], next[i]];
    save(next);
  };
  return (
    <div className="qlib">
      <form className="qform" onSubmit={submit}>
        <label className="field">
          <span>Question</span>
          <input id="myq-text" className="input" value={f.q} maxLength={120} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="Name something Uncle Shlomo always brings to the party" />
        </label>
        <div className="qrows">
          <span className="qhead">Answers, top answer first</span><span className="qhead">Points</span>
          {f.rows.map((r, i) => (
            <React.Fragment key={i}>
              <input id={"myq-a" + i} className="input" value={r.t} maxLength={32} onChange={(e) => setRow(i, "t", e.target.value)} placeholder={`Answer ${i + 1}`} aria-label={`Answer ${i + 1}`} />
              <input id={"myq-p" + i} className="input" value={r.p} inputMode="numeric" maxLength={3} onChange={(e) => setRow(i, "p", e.target.value.replace(/[^0-9]/g, ""))} placeholder={String(AUTO_PTS[i])} aria-label={`Points for answer ${i + 1}`} />
            </React.Fragment>
          ))}
        </div>
        <p className="muted text-sm">Leave the points empty to score them in the order you typed. Answers are optional: without them, players just buzz in and you judge the answer.</p>
        <div className="tool-row">
          <Btn type="submit">{f.id ? "Save changes" : "Save question"}</Btn>
          {(f.id || f.q) && <button type="button" className="chip" onClick={() => { setF(blankForm()); setMsg(""); }}>{f.id ? "Cancel editing" : "Clear"}</button>}
          {msg && <span className="flash">{msg}</span>}
        </div>
        {err === "invalid_argument" && <p className="err">Couldn't save. Only the game's owner or an Editor can save questions.</p>}
      </form>
      {items.length > 0 ? (
        <ol className="qlist">
          {items.map((it, i) => (
            <li key={it.id}>
              <div className="qtext">
                <b>{used.includes(it.id) ? "✓ " : ""}{it.q}</b>
                <span className="muted text-sm">{it.a.length ? it.a.map((r) => `${r[0]} (${r[1]})`).join(" · ") : "Buzz in, you judge"}</span>
              </div>
              <div className="qbtns">
                <button type="button" className="chip" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
                <button type="button" className="chip" onClick={() => move(i, 1)} disabled={i === items.length - 1} aria-label="Move down">↓</button>
                <button type="button" className="chip" onClick={() => edit(it)}>Edit</button>
                {del === it.id
                  ? <button type="button" className="chip chip-warn" onClick={() => { save(items.filter((x) => x.id !== it.id)); setDel(null); }}>Delete?</button>
                  : <button type="button" className="chip" onClick={() => setDel(it.id)}>Delete</button>}
              </div>
            </li>
          ))}
        </ol>
      ) : <p className="muted">No questions yet. They're saved with the game, so they'll still be here on party night.</p>}
    </div>
  );
}

function ScoreTable({ st, inline }) {
  return (
    <div className={"score-table" + (inline ? " inline" : "")}>
      {!inline && <h2 className="display">Scoreboard</h2>}
      <ol>
        {st.map((x, i) => (
          <li key={x.side}><span className="rank">{i + 1}</span><span className="nm">{x.name}</span><b>{x.score}</b></li>
        ))}
      </ol>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Phone screen                                                        */
/* ------------------------------------------------------------------ */

function Phone({ db, room, code, name, onLeave }) {
  const pid = useMemo(myPid, []);
  const recRef = useRef({ pid, code, name, team: null, v: 0, joinedAt: Date.now(), buzz: null, survey: null, guess: null });
  const [rec, setRec] = useState(recRef.current);
  const [sendErr, setSendErr] = useState(null);
  const [early, setEarly] = useState(0);
  const docRef = useMemo(() => db.doc(`rooms/${code}/players/${pid}`), [db, code, pid]);
  const write = useWriter(docRef, (e) => setSendErr(e));
  const [meFast, setMeFast] = useState(false);
  const { state: s, status, hostNow } = useRoomState(db, code, meFast);

  const send = useCallback((patch) => {
    const next = { ...recRef.current, ...patch, v: Math.max((recRef.current.v || 0) + 1, Date.now()), ts: Date.now() };
    recRef.current = next;
    setRec(next);
    write(next);
    if (room) room.presence({ ff: { code, rec: next } }).catch(() => {});
  }, [write, room, code]);

  useEffect(() => {
    local.set("lf-player", JSON.stringify({ code, name }));
    local.set("lf-last-code", code);
    send({ name, code, left: false });
  }, []);

  const inFace = !!(s && s.phase === "faceoff" && s.face && (s.face.p1 === pid || s.face.p2 === pid));
  useEffect(() => { setMeFast(inFace && (s.face.stage === "ready" || s.face.stage === "open")); }, [inFace, s?.face?.stage]);

  // Phone sound and buzz feedback
  const played = useRef(new Set());
  useEffect(() => {
    if (!s?.buzz?.winner || played.current.has(s.buzz.id)) return;
    played.current.add(s.buzz.id);
    if (s.buzz.winner === pid) { Sound.ding(); try { navigator.vibrate && navigator.vibrate([80, 40, 80]); } catch (e) {} }
  }, [s?.buzz?.winner, s?.buzz?.id]);

  const leave = () => { send({ left: true }); local.del("lf-player"); setTimeout(onLeave, 250); };

  const frame = (body, opts = {}) => (
    <div className={"screen phone" + (opts.cls ? " " + opts.cls : "")}>
      <header className="phone-header">
        <span className="display brand-sm">Latke Feud</span>
        <span className="muted text-sm">{name} · {code}</span>
      </header>
      {sendErr === "invalid_argument" && !room && (
        <div className="sync-banner" role="alert">Your phone can see the game but can't send to it. Ask the host to share the game with you with edit access, then reload.</div>
      )}
      <main className="phone-main">{body}</main>
      <footer className="phone-footer">
        <SoundToggle />
        <button type="button" className="chip" onClick={leave}>Leave game</button>
      </footer>
    </div>
  );

  if (!s) {
    if (status === "missing") return frame(
      <div className="phone-card"><h2 className="display text-3xl">No game called {code}</h2><p>Check the code on the TV and try again.</p>
        <p className="muted">{WEB ? `The TV has to host the game on ${SITE} too.` : `The TV has to host the game on this same claude.ai link. For the party, everyone should use ${SITE}.`}</p><Btn onClick={onLeave}>Back</Btn></div>
    );
    return frame(<div className="phone-card"><p className="pulse text-xl">{status === "slow" ? "Still connecting to the game… check your connection." : "Connecting to the game…"}</p></div>);
  }

  const isTeams = s.settings.mode === "teams";
  const myTeam = isTeams ? teamOf(s, pid) : null;
  const mySide = isTeams ? myTeam : pid;
  const kicked = s.kicked?.[pid];
  if (kicked) return frame(<div className="phone-card"><h2 className="display text-3xl">You're out of this game</h2><p>The host removed you. Tap below to join again.</p><Btn onClick={() => send({ left: false })}>Rejoin</Btn></div>);

  const teamBadge = myTeam && <div className={"team-badge " + TEAMS[myTeam].cls}>{teamName(s, myTeam)}</div>;

  if (s.phase === "lobby") {
    const choose = isTeams && s.settings.teamPick === "phones";
    return frame(
      <div className="phone-card">
        <h2 className="display text-4xl">You're in, {name}!</h2>
        {!s.roster[pid] && <p className="muted">Saying hello to the big screen…</p>}
        {choose ? (
          <>
            <p className="text-lg">Pick your team:</p>
            <div className="grid gap-3">
              {["A", "B"].map((t) => (
                <button key={t} type="button" className={"team-pick " + TEAMS[t].cls + (rec.team === t ? " on" : "")} onClick={() => { Sound.ensure(); send({ team: t }); }}>
                  {teamName(s, t)}{rec.team === t ? " ✓" : ""}
                </button>
              ))}
            </div>
          </>
        ) : isTeams ? (
          myTeam ? teamBadge : <p className="text-lg">The host is putting teams together.</p>
        ) : <p className="text-lg">Everyone plays for themselves this time.</p>}
        <p className="muted">Watch the big screen. The game starts soon.</p>
      </div>
    );
  }

  if (s.phase === "survey") {
    return frame(<SurveyCard key={s.survey?.id} s={s} rec={rec} send={send} hostNow={hostNow} />);
  }

  if (s.phase === "faceoff") {
    const f = s.face;
    if (inFace) {
      const opp = f.p1 === pid ? f.p2 : f.p1;
      const open = f.stage === "open" && s.buzz?.open;
      const pressed = rec.buzz?.id === s.buzz?.id;
      const winner = s.buzz?.winner;
      if (winner) {
        const me = winner === pid;
        return frame(
          <div className={"buzz-outcome " + (me ? "won" : "lost")}>
            <div className="display outcome-title">{me ? "You buzzed first!" : "Too slow!"}</div>
            <p className="text-xl">{me ? "Say your answer out loud, then type it!" : `${nameOf(s, winner)} got there first. Buzzers locked.`}</p>
            {f.stage === "answer2" && f.answering === pid && <p className="text-xl gold mt-4">Your turn! Say it, then type it.</p>}
            {s.turn?.pids?.includes(pid) && <AnswerBox key={s.turn.id} s={s} rec={rec} send={send} label={s.openQ ? "Type what you said. The host decides." : "Type what you said"} />}
          </div>, { cls: "phone-buzz" }
        );
      }
      return frame(
        <div className="buzz-wrap">
          <p className="text-lg">Face-off against <b>{nameOf(s, opp)}</b></p>
          <p className="phone-q">{s.question}</p>
          <button
            type="button"
            className={"buzz-btn" + (open && !pressed ? " live" : "") + (pressed ? " pressed" : "") + (early ? " nope" : "")}
            onPointerDown={(e) => {
              e.preventDefault();
              Sound.ensure();
              if (open && !pressed) {
                send({ buzz: { id: s.buzz.id, at: hostNow() } });
                Sound.buzz();
                try { navigator.vibrate && navigator.vibrate(60); } catch (err) {}
              } else if (!open) {
                setEarly((n) => n + 1);
                setTimeout(() => setEarly(0), 500);
              }
            }}
            aria-label="Buzz"
          >
            {pressed ? "BUZZED!" : open ? "BUZZ" : "WAIT"}
          </button>
          <p className="muted">{pressed ? "Checking who was first…" : open ? "Press it!" : early ? "Not yet! Wait for the host." : (f.autoAt ? "Get ready… the buzzer lights up any second!" : "Get ready. The host opens the buzzers.")}</p>
        </div>, { cls: "phone-buzz" }
      );
    }
    return frame(<WatchCard key={s.roundKey} s={s} mySide={mySide} title={`Face-off: ${nameOf(s, f.p1)} vs ${nameOf(s, f.p2)}`} />);
  }

  if (s.phase === "round" || s.phase === "steal") {
    const mine = s.phase === "steal" ? s.stealSide === mySide : s.control === mySide;
    const title = s.phase === "steal"
      ? (mine ? "Your side can steal!" : `${sideName(s, s.stealSide)} is trying to steal`)
      : (mine ? "Your side is guessing!" : `${sideName(s, s.control)} is guessing`);
    const captain = s.phase === "steal" ? s.turn?.pids?.[0] : null;
    const answer = s.turn?.pids?.includes(pid)
      ? <AnswerBox key={s.turn.id} s={s} rec={rec} send={send} label={s.phase === "steal" ? "You answer for your team! Huddle up, agree, then type it" : "Type your team's next answer"} />
      : s.phase === "steal" && mine && captain
        ? <p className="sent-note">Huddle up! Help {nameOf(s, captain)} pick the answer. {nameOf(s, captain)} types it for the team.</p>
        : null;
    return frame(<WatchCard key={s.roundKey} s={s} mySide={mySide} title={title} hot={mine} answer={answer} />);
  }

  if (s.phase === "pick" || s.phase === "roundEnd") {
    const st = standings(s);
    return frame(
      <div className="phone-card">
        {s.last ? (
          <h2 className="display text-3xl"><LastResult s={s} /></h2>
        ) : <h2 className="display text-3xl">Get ready!</h2>}
        {s.sharp?.includes(name) && <p className="gold text-lg">Your guess was on the board. Nice!</p>}
        {teamBadge}
        <ScoreTable st={st} inline />
        <p className="muted">Next round coming up on the big screen.</p>
      </div>
    );
  }

  if (s.phase === "final") {
    const st = standings(s);
    const top = st[0]?.score ?? 0;
    const won = st.some((x) => x.side === mySide && x.score === top);
    return frame(
      <div className="phone-card">
        {won && <Confetti />}
        <p className="eyebrow">Final scores</p>
        <h2 className="display text-4xl">{won ? "You won! Mazel tov!" : `${st.filter((x) => x.score === top).map((x) => x.name).join(" & ")} won!`}</h2>
        <ScoreTable st={st} inline />
        <p className="muted">Chag sameach!</p>
      </div>
    );
  }
  return frame(<div className="phone-card"><p>Watch the big screen.</p></div>);
}

function AnswerBox({ s, rec, send, label }) {
  const t = s.turn;
  const [text, setText] = useState("");
  if (!t) return null;
  if (rec.answer?.id === t.id) return <p className="sent-note">Sent “{rec.answer.text}”. Watch the big screen!</p>;
  return (
    <form className="guess-form" onSubmit={(e) => {
      e.preventDefault();
      const v = clean(text, 40);
      if (v) send({ answer: { id: t.id, text: v, at: Date.now() } });
    }}>
      <label className="field">
        <span>{label}</span>
        <input id="answer-box" className="input big-input" value={text} maxLength={40} onChange={(e) => setText(e.target.value)} placeholder="Type your answer" autoComplete="off" />
      </label>
      <button type="submit" className="btn btn-gold btn-big w-full" disabled={!clean(text)}>Send answer</button>
    </form>
  );
}

function Remote({ db, code, pin, onLeave }) {
  const pid = useMemo(myPid, []);
  const recRef = useRef({ pid, code, name: "Host remote", remote: true, pin, v: 0, cmd: null });
  const docRef = useMemo(() => db.doc(`rooms/${code}/players/${pid}`), [db, code, pid]);
  const write = useWriter(docRef, () => {});
  const { state: s, status } = useRoomState(db, code, true);
  const players = usePlayers(db, null, code, false);
  const [ask, setAsk] = useState("");
  const [waitedLong, setWaitedLong] = useState(false);
  const send = useCallback((patch) => {
    const next = { ...recRef.current, ...patch, v: Math.max((recRef.current.v || 0) + 1, Date.now()), ts: Date.now() };
    recRef.current = next;
    write(next);
  }, [write]);
  useEffect(() => { send({}); const t = setTimeout(() => setWaitedLong(true), 6000); return () => clearTimeout(t); }, []);
  const cmd = (type, arg, extra = {}) => {
    send({ cmd: { id: rid(), type, arg: arg ?? null, at: Date.now(), ...extra } });
    try { navigator.vibrate && navigator.vibrate(20); } catch (e) {}
  };

  const shell = (body) => (
    <div className="screen phone remote">
      <header className="phone-header">
        <span className="display brand-sm">Host remote</span>
        <span className="muted text-sm">Game {code}</span>
      </header>
      <main className="remote-main">{body}</main>
      <footer className="phone-footer">
        <button type="button" className="chip" onClick={() => cmd("undo")} disabled={!s || !(s.remotes || {})[pid]}>↶ Undo</button>
        <button type="button" className="chip" onClick={onLeave}>Leave remote</button>
      </footer>
    </div>
  );

  if (!s) {
    return shell(
      <div className="phone-card">
        <p className="pulse text-xl">{status === "missing" ? `No game called ${code}. Check the code on the TV.` : "Connecting…"}</p>
        {status === "missing" && <Btn onClick={onLeave}>Back</Btn>}
      </div>
    );
  }
  if (!(s.remotes || {})[pid]) {
    return shell(
      <div className="phone-card">
        <p className="pulse text-xl">Connecting to the TV…</p>
        {waitedLong && <p>Still waiting. Check the PIN in Host tools on the TV, and that the TV has game {code} open.</p>}
        {waitedLong && <Btn kind="ghost" onClick={onLeave}>Try a different PIN</Btn>}
      </div>
    );
  }

  const f = s.face;
  const answering = s.phase === "faceoff" && f && (f.stage === "answer1" || f.stage === "answer2");
  const canTap = (answering && !s.openQ) || s.phase === "round" || s.phase === "steal" || s.phase === "roundEnd";
  const hiddenLeft = s.phase === "roundEnd" ? s.board.filter((c) => !c.r).length : 0;
  const st = standings(s);
  const typedRec = answering ? players[f.answering] : null;
  const typedNow = typedRec && typedRec.answer?.id === s.turn?.id ? clean(typedRec.answer.text, 40) : "";

  let main = null;
  if (s.phase === "lobby") {
    main = (
      <>
        <p className="remote-status">{activeIds(s).length} players joined</p>
        <Btn big onClick={() => cmd("start")} disabled={activeIds(s).length < 2}>Start the game</Btn>
      </>
    );
  } else if (s.phase === "pick" || s.phase === "roundEnd") {
    const last = s.roundNo >= s.settings.rounds && s.phase === "roundEnd";
    main = (
      <>
        {s.last && <p className="remote-status"><LastResult s={s} /></p>}
        {hiddenLeft > 0 && <>
          <p className="text-center">{hiddenLeft} {hiddenLeft === 1 ? "answer" : "answers"} nobody found. Tap one in the key to show it, or:</p>
          <Btn big onClick={() => cmd("revealRest")}>Reveal the rest, one by one</Btn>
        </>}
        {hiddenLeft > 0 ? null : last ? <Btn big onClick={() => cmd("finish")}>Crown the winner</Btn> : (
          <>
            <p className="setting-label">Round {s.roundNo + 1}</p>
            <Btn big onClick={() => cmd("next", "mine")}>My next question</Btn>
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (clean(ask)) { cmd("next", "ask", { text: clean(ask, 120) }); setAsk(""); } }}>
              <input id="remote-ask" className="input" value={ask} maxLength={120} onChange={(e) => setAsk(e.target.value)} placeholder="Type a question to ask" />
              <button type="submit" className="btn btn-gold" disabled={!clean(ask)}>Ask</button>
            </form>
            <div className="remote-two">
              <Btn kind="blue" onClick={() => cmd("next", "builtin")}>Ready-made board</Btn>
              <Btn kind="ghost" onClick={() => cmd("next", "survey")}>Family survey</Btn>
            </div>
          </>
        )}
      </>
    );
  } else if (s.phase === "survey") {
    main = (
      <>
        <p className="remote-status">Family survey is running</p>
        <Btn big onClick={() => cmd("closeSurvey")}>Close the survey now</Btn>
        <Btn kind="ghost" onClick={() => cmd("extend")}>+15 seconds</Btn>
      </>
    );
  } else if (s.phase === "faceoff") {
    main = (
      <>
        <p className="remote-status">{nameOf(s, f.p1)} vs {nameOf(s, f.p2)}</p>
        {f.stage === "ready" && f.autoAt && <p className="pulse text-center">Buzzers open by surprise in a few seconds…</p>}
        {f.stage === "ready" && <Btn big onClick={() => cmd("open")}>{f.autoAt ? "Open now" : "Open buzzers"}</Btn>}
        {f.stage === "open" && <><p className="pulse text-lg text-center">Buzzers open. Waiting…</p><Btn kind="ghost" onClick={() => cmd("reset")}>Reset buzzers</Btn></>}
        {answering && (
          <p className="text-lg text-center">
            <b className="gold">{nameOf(s, f.answering)}</b> is answering
            {typedNow ? <> and typed <b className="gold">“{typedNow}”</b></> : null}
          </p>
        )}
        {answering && s.openQ && (
          <div className="remote-two">
            <Btn big onClick={() => cmd("correct")}>Correct</Btn>
            <Btn kind="red" big onClick={() => cmd("strike")}>Wrong</Btn>
          </div>
        )}
        {answering && !s.openQ && <Btn kind="red" big onClick={() => cmd("strike")}>Not on the board</Btn>}
        {s.openQ && f.stage === "ready" && s.note && <Btn kind="ghost" onClick={() => cmd("nobody")}>Nobody got it, move on</Btn>}
      </>
    );
  } else if (s.phase === "round") {
    main = (
      <>
        <p className="remote-status">{sideName(s, s.control)} is guessing · {s.strikes} {s.strikes === 1 ? "strike" : "strikes"}</p>
        <Btn kind="red" big onClick={() => cmd("strike")}>Strike</Btn>
        {s.strikes === 0 && s.board.filter((c) => c.r).length <= 1 && <Btn kind="ghost" onClick={() => cmd("pass")}>Pass to {sideName(s, otherSide(s, s.control))}</Btn>}
      </>
    );
  } else if (s.phase === "steal") {
    main = (
      <>
        <p className="remote-status">{sideName(s, s.stealSide)} can steal {s.bank}</p>
        <Btn kind="red" big onClick={() => cmd("strike")}>Steal missed</Btn>
      </>
    );
  } else if (s.phase === "final") {
    main = (
      <>
        <p className="remote-status">Game over! {st[0]?.name} wins.</p>
        <Btn big onClick={() => cmd("again")}>Play again</Btn>
      </>
    );
  }

  return shell(
    <>
      {s.question && s.phase !== "pick" && s.phase !== "lobby" && <p className="remote-q">{s.question}</p>}
      {s.typed && s.typed.verdict === "pending" && ["faceoff", "round", "steal"].includes(s.phase) && (
        <div className="review">
          <p className="review-title"><b>{s.typed.name}</b> answered</p>
          <p className="review-text">“{s.typed.text}”</p>
          <p className="muted text-sm">
            {s.typed.suggest >= 0 ? <>Looks like <b>#{s.typed.suggest + 1} {s.board[s.typed.suggest]?.t}</b></> : s.typed.dupOf >= 0 ? <>Already on the board (#{s.typed.dupOf + 1})</> : "No matching answer found"}
          </p>
          {s.typed.suggest >= 0 && <Btn big onClick={() => cmd("accept")}>✓ Accept: {s.board[s.typed.suggest]?.t}</Btn>}
          <Btn kind="red" big onClick={() => cmd("strike")}>✕ Not on the board</Btn>
          <p className="muted text-sm">Or tap the right answer in the key below.</p>
        </div>
      )}
      {s.typed && s.typed.verdict !== "pending" && ["faceoff", "round", "steal", "roundEnd"].includes(s.phase) && (
        <div className={"typed small " + s.typed.verdict}>
          {s.typed.name}: “{s.typed.text}” {s.typed.verdict === "hit" ? "✓ matched" : s.typed.verdict === "dup" ? "already up" : s.typed.verdict === "override" ? "you're deciding" : "✕ no match"}
          {s.typed.verdict !== "override" && s.phase !== "roundEnd" && <button type="button" className="chip override" onClick={() => cmd("override")}>Override</button>}
        </div>
      )}
      <div className="remote-actions">{s.typed?.verdict === "pending" && ["faceoff", "round", "steal"].includes(s.phase) ? null : main}</div>
      {s.board.length > 0 && s.phase !== "pick" && (
        <div className="answer-key">
          <p className="setting-label">Answer key{canTap ? (s.phase === "roundEnd" ? " · tap to show on TV" : " · tap to flip") : ""}</p>
          {s.board.map((c, i) => (
            <button key={i} type="button" className={"key-row" + (c.r ? " done" : "")} disabled={!canTap || c.r} onClick={() => cmd("tap", i)}>
              <span className="key-n">{i + 1}</span><span className="key-t">{c.t}</span><b>{c.p}</b>
            </button>
          ))}
          {s.phase !== "roundEnd" && <p className="muted text-sm">Bank: {s.bank}</p>}
        </div>
      )}
      <div className="remote-scores">{st.map((x) => <span key={x.side}>{x.name} <b>{x.score}</b></span>)}</div>
    </>
  );
}

function SurveyCard({ s, rec, send, hostNow }) {
  const mine = rec.survey?.id === s.survey?.id ? rec.survey.text : "";
  const [text, setText] = useState(mine);
  const timeUp = s.survey?.done || hostNow() >= s.survey?.endsAt;
  const [, force] = useState(0);
  useEffect(() => { const t = setInterval(() => force((x) => x + 1), 500); return () => clearInterval(t); }, []);
  const submit = (e) => {
    e.preventDefault();
    const t = clean(text, 32);
    if (!t || timeUp) return;
    send({ survey: { id: s.survey.id, text: t, at: hostNow() } });
  };
  return (
    <form className="phone-card" onSubmit={submit}>
      <p className="eyebrow">Family survey</p>
      <p className="phone-q big">{s.question}</p>
      {!s.survey?.empty && <Countdown endsAt={s.survey.endsAt} now={hostNow} total={s.survey.total || SURVEY_MS} />}
      {s.survey?.empty ? <p className="text-lg">The host is giving everyone a little more time.</p> : null}
      <input id="survey-answer" className="input big-input" value={text} maxLength={32} onChange={(e) => setText(e.target.value)} placeholder="Your answer" disabled={timeUp} autoComplete="off" />
      <button type="submit" className="btn btn-gold btn-big w-full" disabled={timeUp || !clean(text)}>{mine && clean(text) === mine ? "Sent ✓" : mine ? "Change my answer" : "Send answer"}</button>
      <p className="muted">{timeUp ? "Time's up! Look at the big screen." : "One short answer. Keep it secret!"}</p>
    </form>
  );
}

// What's at stake right now, in plain words, from the point of view of `mySide`.
function situation(s, mySide) {
  const who = (side) => (side === mySide ? (s.settings.mode === "teams" ? "your team" : "you") : sideName(s, side));
  const Who = (side) => { const w = who(side); return w.charAt(0).toUpperCase() + w.slice(1); };
  const hidden = s.board.filter((c) => !c.r).length;
  if (s.phase === "faceoff") {
    const f = s.face;
    if (s.openQ) return "First to buzz answers. Right answer wins the points!";
    if (f.stage === "answer2") return `${nameOf(s, f.first?.pid)} missed! ${nameOf(s, f.answering)} can win control with any answer on the board.`;
    if (f.stage === "answer1") return `${nameOf(s, f.answering)} buzzed first. Any answer on the board wins control.`;
    return "First to buzz answers. Any answer on the board wins control for their team.";
  }
  if (s.phase === "round") {
    const other = otherSide(s, s.control);
    if (s.strikes === 0) return `${Who(s.control)} ${who(s.control) === "you" ? "are" : "is"} on a roll. ${hidden} ${hidden === 1 ? "answer" : "answers"} left to find. Clear the board to keep all ${s.bank} points!`;
    if (s.strikes === 1) return `1 strike. Two more and ${who(other)} can steal the ${s.bank} points.`;
    return `2 strikes! One more X and ${who(other)} get${who(other) === "you" ? "" : "s"} a chance to steal all ${s.bank} points!`;
  }
  if (s.phase === "steal") {
    return `${Who(s.stealSide)} get${who(s.stealSide) === "you" ? "" : "s"} ONE guess. Right answer steals all ${s.bank} points. Wrong and ${who(s.control)} keep${who(s.control) === "you" ? "" : "s"} them.`;
  }
  return "";
}

function WatchCard({ s, title, hot, answer, mySide }) {
  const st = standings(s);
  const hidden = s.board.filter((c) => !c.r).length;
  const showStrikes = s.phase === "round" || s.phase === "steal";
  return (
    <div className={"phone-card" + (hot ? " hot" : "")}>
      <h2 className="display text-3xl">{title}</h2>
      <p className="phone-q">{s.question}</p>
      {s.typed && <p className={"typed small " + s.typed.verdict}>{s.typed.name}: “{s.typed.text}” {s.typed.verdict === "pending" ? "(host is checking…)" : s.typed.verdict === "hit" ? "✓ on the board" : s.typed.verdict === "dup" ? "(already up)" : s.typed.verdict === "override" ? "(host is deciding)" : "✕ not on the board"}</p>}
      {answer}
      <div className="stakes">
        {showStrikes && (
          <div className="phone-strikes" aria-label={`${s.strikes} of 3 strikes`}>
            {[0, 1, 2].map((i) => <span key={i} className={"pstrike" + (i < s.strikes ? " on" : "")}>✕</span>)}
          </div>
        )}
        <p className="stakes-line">{situation(s, mySide)}</p>
        {!s.openQ && s.board.length > 0 && (
          <div className="stakes-nums">
            <span>Bank <b>{s.bank}</b></span>
            <span>Hidden answers <b>{hidden}</b></span>
          </div>
        )}
      </div>
      <div className="mini-scores">
        {st.map((x) => (
          <span key={x.side} className={x.side === mySide ? "me" : ""}>{x.name}{x.side === mySide ? " (you)" : ""} <b>{x.score}</b></span>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* App shell                                                           */
/* ------------------------------------------------------------------ */

function App() {
  const caps = useCapabilities();
  const [mode, setMode] = useState(() => {
    try {
      const p = JSON.parse(local.get("lf-player") || "null");
      if (p && /^[A-Z]{4}$/.test(p.code) && p.name) return { kind: "phone", code: p.code, name: p.name };
      const r = JSON.parse(local.get("lf-remote") || "null");
      if (r && /^[A-Z]{4}$/.test(r.code) && /^\d{4}$/.test(r.pin)) return { kind: "remote", code: r.code, pin: r.pin };
    } catch (e) {}
    return { kind: "landing" };
  });
  const [busy, setBusy] = useState("");

  if (caps.loading) return <div className="screen center"><p className="pulse text-2xl">Lighting the candles…</p></div>;
  if (!caps.db) {
    return (
      <ErrorScreen title="Shared storage isn't available">
        <p>This game keeps the TV and everyone's phones in sync through the artifact's shared storage, and this view can't reach it.</p>
        <p>Open the game from its claude.ai link and make sure you're signed in to Claude. If you are, reload the page.</p>
        <p className="muted">People outside your organization need to be invited to the game by email to send buzzes and answers.</p>
      </ErrorScreen>
    );
  }
  const { db, room } = caps;

  const host = async (resume) => {
    setBusy("Setting the table…");
    try {
      if (resume) {
        const snap = await db.doc("rooms/" + resume).get();
        if (snap.exists && snap.data()) { setMode({ kind: "host", code: resume, initial: snap.data() }); setBusy(""); return; }
        local.del("lf-host-code");
      }
      let code = makeCode();
      for (let i = 0; i < 5; i++) {
        const snap = await db.doc("rooms/" + code).get().catch(() => null);
        if (!snap || !snap.exists) break;
        code = makeCode();
      }
      setMode({ kind: "host", code, initial: newGame(code) });
    } catch (e) {
      setMode({ kind: "landing" });
    }
    setBusy("");
  };

  if (busy) return <div className="screen center"><p className="pulse text-2xl">{busy}</p></div>;
  if (mode.kind === "host") return <Host db={db} room={room} code={mode.code} initial={mode.initial} onExit={() => { local.del("lf-host-code"); setMode({ kind: "landing" }); }} />;
  if (mode.kind === "phone") return <Phone db={db} room={room} code={mode.code} name={mode.name} onLeave={() => setMode({ kind: "landing" })} />;
  if (mode.kind === "remote") return <Remote db={db} code={mode.code} pin={mode.pin} onLeave={() => { local.del("lf-remote"); setMode({ kind: "landing" }); }} />;
  if (mode.kind === "prep") return <Prep db={db} onBack={() => setMode({ kind: "landing" })} onHost={() => host(null)} />;
  return <Landing db={db} onHost={() => host(null)} onResume={(c) => host(c)} onPrep={() => setMode({ kind: "prep" })} onRemote={(code, pin) => { local.set("lf-remote", JSON.stringify({ code, pin })); setMode({ kind: "remote", code, pin }); }} onJoin={(code, name) => setMode({ kind: "phone", code, name })} />;
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
