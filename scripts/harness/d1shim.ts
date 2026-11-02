// Shim D1 minimal di atas node:sqlite (Node >= 22.5) untuk harness pengukuran lokal TANPA wrangler.
// Hanya subset API yang dipakai kode agen: prepare().bind().first()/all()/run(), batch(), exec().
// `latencyMs` menambahkan jeda per query untuk mendekati D1 remote dari Durable Object (bukan nol).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
// createRequire: vite-node (vitest) belum mengenali `node:sqlite` sebagai builtin bila di-import statis.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
type DatabaseSync = InstanceType<typeof DatabaseSync>;

class Stmt {
  constructor(private db: DatabaseSync, private sql: string, private args: unknown[], private latencyMs: number) {}
  bind(...args: unknown[]) {
    return new Stmt(this.db, this.sql, args, this.latencyMs);
  }
  private async delay() {
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
  }
  private norm() {
    return this.args.map((a) => (a === undefined ? null : typeof a === "boolean" ? (a ? 1 : 0) : a)) as any[];
  }
  async first<T = any>(col?: string): Promise<T | null> {
    await this.delay();
    const row: any = this.db.prepare(this.sql).get(...this.norm());
    if (!row) return null;
    return (col ? row[col] : { ...row }) as T;
  }
  async all<T = any>(): Promise<{ results: T[]; success: true }> {
    await this.delay();
    const rows: any[] = this.db.prepare(this.sql).all(...this.norm());
    return { results: rows.map((r) => ({ ...r })) as T[], success: true };
  }
  async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    await this.delay();
    const r: any = this.db.prepare(this.sql).run(...this.norm());
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async raw(): Promise<any[][]> {
    const rows = await this.all();
    return rows.results.map((r: any) => Object.values(r));
  }
}

export function createD1(opts: { latencyMs?: number } = {}): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync("src/db/schema.sql", "utf-8"));
  db.exec(readFileSync("data/synthetic/seed.sql", "utf-8"));
  const latencyMs = opts.latencyMs ?? 0;
  return {
    prepare: (sql: string) => new Stmt(db, sql, [], latencyMs),
    batch: async (stmts: Stmt[]) => Promise.all(stmts.map((s) => s.run())),
    exec: async (sql: string) => {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;
}
