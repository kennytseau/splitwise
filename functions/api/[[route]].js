/**
 * Evenly sync API — a Cloudflare Pages Function backed by D1.
 *
 * Routes
 *   POST /api/ledger   { keyHash }                  -> { id }
 *   POST /api/sync     { records[], since }         -> { records[], cursor, more }
 *
 * A "ledger" is one shared space. Its id is public. The key in the header is
 * NOT the share secret: it is an auth key derived from it, and only its
 * SHA-256 is stored. The separate encryption key never leaves the client, so
 * this server cannot read a record body even while holding a valid auth key.
 *
 * Record bodies arrive as AES-GCM envelopes, {v, iv, ct}. They are opaque
 * here and are stored and returned verbatim. Nothing in this file should ever
 * try to interpret one.
 *
 * Conflict handling is last-writer-wins on the client-supplied `updated`
 * timestamp. Every push echoes back the server's current version of each
 * record it touched, so a client whose write loses still converges.
 */

const KINDS = ["groups", "expenses", "settlements"];

const MAX_RECORDS_PER_PUSH = 400;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_RECORD_BYTES = 32 * 1024;
const MAX_RECORDS_PER_LEDGER = 20000;
const PULL_PAGE = 400;

export async function onRequest(context) {
  const { request, env, params } = context;
  const route = (Array.isArray(params.route) ? params.route : [params.route])
    .filter(Boolean)
    .join("/");

  try {
    if (!env.DB) return json({ error: "no_database" }, 500);

    if (route === "ledger" && request.method === "POST") {
      return await createLedger(request, env);
    }
    if (route === "sync" && request.method === "POST") {
      const auth = await authorise(request, env);
      if (!auth.ok) return json({ error: auth.error }, auth.status);
      return await sync(request, env, auth.ledger);
    }
    return json({ error: "not_found" }, 404);
  } catch (err) {
    return json({ error: "server_error" }, 500);
  }
}

/* ---------------------------------------------------------------- helpers */

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compare two equal-length hex strings without leaking position via timing. */
function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function newLedgerId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readJson(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) return { tooBig: true };
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { tooBig: true };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { bad: true };
  }
}

/* ------------------------------------------------------------- ledgers */

async function createLedger(request, env) {
  const parsed = await readJson(request);
  if (parsed.tooBig || parsed.bad || !parsed.value) return json({ error: "bad_request" }, 400);

  const keyHash = parsed.value.keyHash;
  if (typeof keyHash !== "string" || !/^[a-f0-9]{64}$/.test(keyHash)) {
    return json({ error: "bad_request" }, 400);
  }

  const id = newLedgerId();
  await env.DB.prepare(
    "INSERT INTO ledgers (id, key_hash, seq, created) VALUES (?1, ?2, 0, ?3)"
  )
    .bind(id, keyHash, Date.now())
    .run();

  return json({ id });
}

async function authorise(request, env) {
  const id = request.headers.get("x-ledger-id") || "";
  const key = request.headers.get("x-ledger-key") || "";
  if (!/^[a-f0-9]{8,64}$/.test(id) || !/^[a-f0-9]{32,80}$/.test(key)) {
    return { ok: false, error: "unauthorised", status: 401 };
  }

  const row = await env.DB.prepare("SELECT id, key_hash FROM ledgers WHERE id = ?1")
    .bind(id)
    .first();
  if (!row) return { ok: false, error: "unauthorised", status: 401 };

  const given = await sha256Hex(key);
  if (!sameSecret(given, row.key_hash)) {
    return { ok: false, error: "unauthorised", status: 401 };
  }
  return { ok: true, ledger: id };
}

/* ---------------------------------------------------------------- sync */

function validRecord(r) {
  if (!r || typeof r !== "object") return false;
  if (!KINDS.includes(r.kind)) return false;
  if (typeof r.id !== "string" || !/^[A-Za-z0-9_.~:@+-]{1,64}$/.test(r.id)) return false;
  if (!Number.isFinite(r.updated) || r.updated < 0) return false;
  if (r.body == null || typeof r.body !== "object" || Array.isArray(r.body)) return false;
  return true;
}

async function sync(request, env, ledger) {
  const parsed = await readJson(request);
  if (parsed.tooBig) return json({ error: "too_large" }, 413);
  if (parsed.bad || !parsed.value) return json({ error: "bad_request" }, 400);

  const body = parsed.value;
  const since = Number.isFinite(body.since) && body.since >= 0 ? Math.floor(body.since) : 0;
  const incoming = Array.isArray(body.records) ? body.records : [];
  if (incoming.length > MAX_RECORDS_PER_PUSH) return json({ error: "too_many_records" }, 413);

  const touched = [];

  if (incoming.length) {
    const clean = [];
    for (const r of incoming) {
      if (!validRecord(r)) return json({ error: "bad_record" }, 400);
      const serialised = JSON.stringify(r.body);
      if (serialised.length > MAX_RECORD_BYTES) return json({ error: "record_too_large" }, 413);
      clean.push({
        kind: r.kind,
        id: r.id,
        body: serialised,
        updated: Math.floor(r.updated),
        deleted: r.deleted ? 1 : 0,
      });
    }

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM records WHERE ledger = ?1"
    )
      .bind(ledger)
      .first();
    if (count && count.n >= MAX_RECORDS_PER_LEDGER) {
      return json({ error: "ledger_full" }, 507);
    }

    // One sequence number per push: the cursor every client pages against.
    const bumped = await env.DB.prepare(
      "UPDATE ledgers SET seq = seq + 1 WHERE id = ?1 RETURNING seq"
    )
      .bind(ledger)
      .first();
    const seq = bumped ? bumped.seq : 0;

    const upsert = env.DB.prepare(
      `INSERT INTO records (ledger, kind, id, body, updated, deleted, seq)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (ledger, kind, id) DO UPDATE SET
         body = excluded.body,
         updated = excluded.updated,
         deleted = excluded.deleted,
         seq = excluded.seq
       WHERE excluded.updated >= records.updated`
    );
    await env.DB.batch(
      clean.map((r) =>
        upsert.bind(ledger, r.kind, r.id, r.body, r.updated, r.deleted, seq)
      )
    );

    // Echo the authoritative version of everything just pushed, so a client
    // whose write was rejected as stale still ends up agreeing with the server.
    const echo = env.DB.prepare(
      "SELECT kind, id, body, updated, deleted, seq FROM records WHERE ledger = ?1 AND kind = ?2 AND id = ?3"
    );
    const rows = await env.DB.batch(
      clean.map((r) => echo.bind(ledger, r.kind, r.id))
    );
    for (const result of rows) {
      for (const row of result.results || []) touched.push(row);
    }
  }

  const page = await env.DB.prepare(
    `SELECT kind, id, body, updated, deleted, seq FROM records
     WHERE ledger = ?1 AND seq > ?2
     ORDER BY seq ASC, kind ASC, id ASC
     LIMIT ?3`
  )
    .bind(ledger, since, PULL_PAGE + 1)
    .all();

  const rows = page.results || [];
  const more = rows.length > PULL_PAGE;
  const delivered = more ? rows.slice(0, PULL_PAGE) : rows;

  let cursor = since;
  for (const row of delivered) cursor = Math.max(cursor, row.seq);

  const merged = new Map();
  for (const row of [...delivered, ...touched]) merged.set(row.kind + "/" + row.id, row);

  const records = [];
  for (const row of merged.values()) {
    let parsedBody = {};
    try {
      parsedBody = JSON.parse(row.body);
    } catch {
      parsedBody = {};
    }
    records.push({
      kind: row.kind,
      id: row.id,
      body: parsedBody,
      updated: row.updated,
      deleted: row.deleted ? 1 : 0,
    });
  }

  return json({ records, cursor, more });
}
