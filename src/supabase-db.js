// Same doc/collection interface the game uses on claude.ai, backed by a Supabase table
// (public.kv: path, parent, data). Used by the public web build.

const err = (code, message) => ({ code, message });

export function makeSupabaseDb(url, key) {
  const base = url.replace(/\/$/, "") + "/rest/v1/kv";
  const headers = { apikey: key, "Content-Type": "application/json" };
  const enc = encodeURIComponent;

  async function req(method, query, body, extra = {}) {
    let r;
    try {
      r = await fetch(base + query, { method, headers: { ...headers, ...extra }, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
    } catch (e) {
      throw err("unavailable", String(e));
    }
    if (r.status === 429) throw err("resource_exhausted", "Too many requests");
    if (r.status >= 500) throw err("unavailable", "Server error " + r.status);
    if (!r.ok) throw err("invalid_argument", await r.text().catch(() => "Bad request"));
    return method === "GET" ? r.json() : null;
  }

  const meta = { fromCache: false, hasPendingWrites: false };
  const snap = (path, d) => ({ id: path.split("/").pop(), exists: !!d, data: () => d || undefined, metadata: meta });
  const qsnap = (rows) => {
    const docs = rows.map((r) => snap(r.path, r.data));
    return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: meta };
  };
  const poll = (fetchOnce, next, ms) => {
    let alive = true, last = null;
    (async () => {
      while (alive) {
        try {
          const v = await fetchOnce();
          const k = JSON.stringify(v);
          if (alive && k !== last) { last = k; next(v); }
        } catch (e) {}
        await new Promise((r) => setTimeout(r, ms));
      }
    })();
    return () => { alive = false; };
  };

  function doc(path) {
    const getData = async () => {
      const rows = await req("GET", `?path=eq.${enc(path)}&select=data`);
      return rows[0]?.data || null;
    };
    const ref = {
      id: path.split("/").pop(),
      path,
      async get() { return snap(path, await getData()); },
      async set(data) {
        await req("POST", "", { path, data }, { Prefer: "resolution=merge-duplicates,return=minimal" });
      },
      async update(data) {
        const cur = await getData();
        if (!cur) throw err("invalid_argument", "Document does not exist");
        await ref.set({ ...cur, ...data });
      },
      async delete() { throw err("invalid_argument", "Delete is not supported"); },
      onSnapshot(next) { return poll(getData, (d) => next(snap(path, d)), 1500); },
      collection(sub) { return collection(path + "/" + sub); },
    };
    return ref;
  }

  function collection(path, filters = [], lim = 200) {
    const fetchRows = async () => {
      let rows = await req("GET", `?parent=eq.${enc(path)}&select=path,data&order=updated_at.desc&limit=300`);
      rows = rows.filter((r) => filters.every(([f, op, v]) => {
        const x = r.data?.[f];
        if (op === ">") return x > v;
        if (op === ">=") return x >= v;
        if (op === "<") return x < v;
        if (op === "<=") return x <= v;
        if (op === "==") return x === v;
        if (op === "!=") return x !== v;
        return true;
      }));
      return rows.slice(0, lim);
    };
    return {
      path,
      doc: (id) => doc(path + "/" + id),
      where: (f, op, v) => collection(path, [...filters, [f, op, v]], lim),
      orderBy: () => collection(path, filters, lim),
      limit: (n) => collection(path, filters, n),
      async get() { return qsnap(await fetchRows()); },
      onSnapshot(next) { return poll(fetchRows, (rows) => next(qsnap(rows)), 1500); },
      async add(data) { const d = doc(path + "/p" + Math.random().toString(36).slice(2, 10)); await d.set(data); return d; },
    };
  }

  return { doc, collection };
}
