// Cloudflare's Durable Object SQL API (ctx.storage.sql), stood in for by Node's
// own SQLite, so the tests run the planning against the real SQL of the store.
import { DatabaseSync } from "node:sqlite";
import { sqlStore } from "./planning-store.js";

export function sqliteStorage() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query, ...bindings) {
      const statement = db.prepare(query);
      const rows = /^\s*(select|with)\b/i.test(query) ? statement.all(...bindings).map((row) => ({ ...row })) : (statement.run(...bindings), []);
      return { toArray: () => rows, one: () => rows[0] };
    },
  };
}

// The store as the flow tests see it: the same calls as their in-memory KV,
// counted the same way, with the same peek at a raw entry.
export class SqlKV {
  constructor() {
    this.sql = sqliteStorage();
    this.store = sqlStore(this.sql);
    this.ops = { get: 0, put: 0, delete: 0, list: 0 };
    this.perKeyRate = false;
  }
  async get(key, type) {
    this.ops.get += 1;
    return this.store.get(key, type);
  }
  async put(key, value, options) {
    this.ops.put += 1;
    return this.store.put(key, value, options);
  }
  async delete(key) {
    this.ops.delete += 1;
    return this.store.delete(key);
  }
  async list(options) {
    this.ops.list += 1;
    return this.store.list(options);
  }
  entry(key) {
    const [row] = this.sql.exec("SELECT value, metadata, expiration FROM kv WHERE key = ?", key).toArray();
    if (!row || (row.expiration !== null && row.expiration * 1000 < Date.now())) return null;
    return { value: row.value, metadata: row.metadata === null ? undefined : JSON.parse(row.metadata), expiration: row.expiration ?? undefined };
  }
  get map() {
    return {
      set: (key, entry) => this.sql.exec(
        "INSERT INTO kv (key, value, metadata, expiration) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, metadata = excluded.metadata, expiration = excluded.expiration",
        key, entry.value, entry.metadata === undefined ? null : JSON.stringify(entry.metadata), entry.expiration ?? null,
      ),
    };
  }
}
