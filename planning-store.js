// The planning's storage: one Durable Object with its own SQLite database, on
// Cloudflare's free plan. Workers KV, which held everything before, allows 1,000
// listings a day on that plan. Two screens left open all day spent them, and from
// then until 02:00 nothing worked, the driver's Bezorgd included. Here reading
// allows 5 million rows a day and writing 100,000, a read sees every earlier write
// at once, and there is no rule of one write per key per second.
//
// The Worker still talks to it the way it talked to KV (get, put, delete, list),
// so the planning code itself did not have to change for the move.

export function sqlStore(sql, now = () => Date.now()) {
  sql.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, metadata TEXT, expiration INTEGER) WITHOUT ROWID");
  const seconds = () => Math.floor(now() / 1000);
  const expirationOf = (options) => {
    if (options?.expiration) return Math.floor(Number(options.expiration));
    if (options?.expirationTtl) return seconds() + Math.floor(Number(options.expirationTtl));
    return null;
  };

  return {
    async get(key, type) {
      const [row] = sql.exec("SELECT value, expiration FROM kv WHERE key = ?", String(key)).toArray();
      if (!row || (row.expiration !== null && row.expiration <= seconds())) return null;
      const kind = typeof type === "string" ? type : type?.type;
      return kind === "json" ? JSON.parse(row.value) : row.value;
    },

    async put(key, value, options = {}) {
      sql.exec(
        "INSERT INTO kv (key, value, metadata, expiration) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, metadata = excluded.metadata, expiration = excluded.expiration",
        String(key),
        String(value),
        options.metadata === undefined ? null : JSON.stringify(options.metadata),
        expirationOf(options),
      );
    },

    async delete(key) {
      sql.exec("DELETE FROM kv WHERE key = ?", String(key));
    },

    // Keys in order, as KV lists them. The range on the key itself keeps a
    // listing of one prefix from reading, and counting, every row in the table.
    async list({ prefix = "", cursor, limit = 1000 } = {}) {
      const size = Math.min(Math.max(Number(limit) || 1000, 1), 1000);
      const after = cursor ? String(cursor) : null;
      const upper = prefixEnd(prefix);
      const rows = sql.exec(
        `SELECT key, metadata, expiration FROM kv
          WHERE key >= ? ${after ? "AND key > ?" : ""} ${upper ? "AND key < ?" : ""}
            AND (expiration IS NULL OR expiration > ?)
          ORDER BY key LIMIT ?`,
        ...[prefix, ...(after ? [after] : []), ...(upper ? [upper] : []), seconds(), size],
      ).toArray();
      const keys = rows.map((row) => ({
        name: row.key,
        ...(row.expiration !== null ? { expiration: row.expiration } : {}),
        ...(row.metadata !== null ? { metadata: JSON.parse(row.metadata) } : {}),
      }));
      const complete = rows.length < size;
      return { keys, list_complete: complete, ...(complete ? {} : { cursor: rows[rows.length - 1].key }) };
    },

    // Expired rows are already invisible; this frees their space. Run daily.
    purge() {
      sql.exec("DELETE FROM kv WHERE expiration IS NOT NULL AND expiration <= ?", seconds());
    },

    // How much sits under each prefix, for checking the move. Names only.
    counts() {
      const rows = sql.exec("SELECT key FROM kv WHERE expiration IS NULL OR expiration > ?", seconds()).toArray();
      const counts = {};
      for (const { key } of rows) {
        const prefix = key.includes(":") ? key.slice(0, key.indexOf(":")) : key;
        counts[prefix] = (counts[prefix] || 0) + 1;
      }
      return counts;
    },
  };
}

// The first string after every string that starts with the prefix: "order:"
// becomes "order;". Keys here are plain ASCII up to the prefix.
function prefixEnd(prefix) {
  if (!prefix) return null;
  return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
}

// Once, the first time the object wakes up: everything in KV is copied over,
// with its expiry and metadata, so nothing from before the move is lost. KV is
// left as it was, as a copy of the day of the move.
//
// Everything is read first; then the table is filled in one go, without a
// pause in between, so it is written whole or not at all. Until the copy is
// done the site keeps running on KV (see PlanningStore), so KV is the truth:
// a copy tried again after a failure starts from an empty table.
export async function copyFromKv(kv, sql) {
  sql.exec("CREATE TABLE IF NOT EXISTS store_meta (name TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
  const [done] = sql.exec("SELECT value FROM store_meta WHERE name = 'copied-from-kv'").toArray();
  if (done) return JSON.parse(done.value);
  if (!kv) return null;

  const keys = [];
  let cursor;
  for (let page = 0; page < 50; page += 1) {
    const result = await kv.list({ cursor });
    keys.push(...result.keys);
    if (result.list_complete || !result.cursor) break;
    cursor = result.cursor;
  }
  const now = Math.floor(Date.now() / 1000);
  const living = keys.filter((key) => !key.expiration || key.expiration > now);
  // Fifty at a time: one by one, a few thousand keys would outlast the half
  // minute the object may take to start.
  const values = [];
  for (let start = 0; start < living.length; start += 50) {
    values.push(...await Promise.all(living.slice(start, start + 50).map((key) => kv.get(key.name))));
  }

  sql.exec("DELETE FROM kv");
  let copied = 0;
  living.forEach((key, index) => {
    if (values[index] === null) return;
    sql.exec(
      "INSERT INTO kv (key, value, metadata, expiration) VALUES (?, ?, ?, ?)",
      key.name,
      values[index],
      key.metadata === undefined ? null : JSON.stringify(key.metadata),
      key.expiration || null,
    );
    copied += 1;
  });
  const record = { at: new Date().toISOString(), listed: keys.length, copied };
  sql.exec("INSERT INTO store_meta (name, value) VALUES ('copied-from-kv', ?)", JSON.stringify(record));
  return record;
}
