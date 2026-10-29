import { describe, expect, it, vi } from "vitest";
import { setConsent, getMemory, saveMemorySummary, deleteMemory } from "../../src/extras/memory/longTermMemory";
import { buildMemoryRoutes } from "../../src/extras/memory/routes";

function fakeD1() {
  const store = new Map<string, any>();
  const db = {
    prepare: (sql: string) => {
      let boundArgs: any[] = [];
      const api = {
        bind: (...args: any[]) => {
          boundArgs = args;
          return api;
        },
        run: async () => {
          if (sql.startsWith("DELETE")) {
            store.delete(boundArgs[0]);
          } else if (sql.startsWith("INSERT")) {
            const [actorId, actorType, summary, consentGiven, consentAt, updatedAt] = boundArgs;
            const existing = store.get(actorId);
            if (existing && sql.includes("ON CONFLICT")) {
              store.set(actorId, { ...existing, consent_given: consentGiven, consent_at: consentAt, updated_at: updatedAt });
            } else {
              store.set(actorId, { actor_id: actorId, actor_type: actorType, summary, consent_given: consentGiven, consent_at: consentAt, updated_at: updatedAt });
            }
          } else if (sql.startsWith("UPDATE")) {
            const [summary, updatedAt, actorId] = boundArgs;
            const existing = store.get(actorId);
            if (existing) store.set(actorId, { ...existing, summary, updated_at: updatedAt });
          }
          return {};
        },
        first: async () => {
          const actorId = boundArgs[0];
          const row = store.get(actorId);
          if (!row) return null;
          if (sql.includes("SELECT consent_given")) return { consent_given: row.consent_given };
          return row;
        },
      };
      return api;
    },
  };
  return { db: db as unknown as D1Database, store };
}

describe("memory/longTermMemory", () => {
  it("getMemory returns null when no consent has been granted", async () => {
    const { db } = fakeD1();
    const { record, xray } = await getMemory({ DB: db }, "MIT-0001");
    expect(record).toBeNull();
    expect(xray.data.found).toBe(false);
  });

  it("saveMemorySummary refuses to write without consent on file", async () => {
    const { db } = fakeD1();
    const result = await saveMemorySummary({ DB: db }, "MIT-0001", "mitra", "suka gaya informal");
    expect(result.saved).toBe(false);
    expect(result.reason).toBe("no_consent");
  });

  it("stores and reads back a clean summary once consent is granted", async () => {
    const { db } = fakeD1();
    await setConsent({ DB: db }, "MIT-0001", "mitra", true);
    const saveResult = await saveMemorySummary({ DB: db }, "MIT-0001", "mitra", "Lebih suka gaya bahasa Jawa informal, sering tanya soal restrukturisasi.");
    expect(saveResult.saved).toBe(true);

    const { record } = await getMemory({ DB: db }, "MIT-0001");
    expect(record?.summary).toContain("restrukturisasi");
    expect(record?.consentGiven).toBe(true);
  });

  it("refuses to store a summary that still contains raw PII (hard safety net)", async () => {
    const { db } = fakeD1();
    await setConsent({ DB: db }, "MIT-0001", "mitra", true);
    const result = await saveMemorySummary({ DB: db }, "MIT-0001", "mitra", "HP mitra 081234567890, suka dihubungi sore.");
    expect(result.saved).toBe(false);
    expect(result.reason).toContain("pii_detected");
  });

  it("withdrawing consent immediately deletes the stored summary (hak hapus)", async () => {
    const { db } = fakeD1();
    await setConsent({ DB: db }, "MIT-0001", "mitra", true);
    await saveMemorySummary({ DB: db }, "MIT-0001", "mitra", "suka gaya informal dan ramah");
    await setConsent({ DB: db }, "MIT-0001", "mitra", false);

    const { record } = await getMemory({ DB: db }, "MIT-0001");
    expect(record).toBeNull();
  });

  it("deleteMemory hard-deletes the row outright", async () => {
    const { db, store } = fakeD1();
    await setConsent({ DB: db }, "MIT-0002", "mitra", true);
    await deleteMemory({ DB: db }, "MIT-0002");
    expect(store.has("MIT-0002")).toBe(false);
  });
});

describe("memory routes", () => {
  function fakeEnv() {
    const { db } = fakeD1();
    return { FEATURE_LONG_TERM_MEMORY: "true", DB: db } as any;
  }

  it("rejects when FEATURE_LONG_TERM_MEMORY is disabled", async () => {
    const app = buildMemoryRoutes();
    const res = await app.request("/memory/MIT-0001", {}, { FEATURE_LONG_TERM_MEMORY: "false" } as any);
    expect(res.status).toBe(404);
  });

  it("grants consent, stores a summary, then reads it back via the routes", async () => {
    const app = buildMemoryRoutes();
    const env = fakeEnv();

    const consentRes = await app.request(
      "/memory/MIT-0001/consent",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actorType: "mitra", granted: true }) },
      env,
    );
    expect(consentRes.status).toBe(200);

    const saveRes = await app.request(
      "/memory/MIT-0001",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actorType: "mitra", summary: "suka gaya santai" }) },
      env,
    );
    expect((await saveRes.json()).saved).toBe(true);

    const getRes = await app.request("/memory/MIT-0001", {}, env);
    const body = await getRes.json();
    expect(body.record.summary).toBe("suka gaya santai");
  });

  it("DELETE removes the record (hak hapus)", async () => {
    const app = buildMemoryRoutes();
    const env = fakeEnv();
    await app.request(
      "/memory/MIT-0001/consent",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actorType: "mitra", granted: true }) },
      env,
    );
    const delRes = await app.request("/memory/MIT-0001", { method: "DELETE" }, env);
    expect((await delRes.json()).deleted).toBe(true);
  });
});
