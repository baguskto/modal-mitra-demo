import { describe, expect, it, vi } from "vitest";
import { decideEscalation, notifyEscalation } from "../../src/extras/workflows/decision";
import { buildSlaRoutes } from "../../src/extras/workflows/routes";

describe("workflows/slaEscalationWorkflow decideEscalation", () => {
  it("escalates when the session is still HUMAN and CS never replied", () => {
    const result = decideEscalation({ mode: "HUMAN", last_sender: "ai", handoff_at: "x" }, 5);
    expect(result.outcome).toBe("escalated");
  });

  it("does not escalate once CS has replied (last_sender === 'human')", () => {
    const result = decideEscalation({ mode: "HUMAN", last_sender: "human", handoff_at: "x" }, 5);
    expect(result.outcome).toBe("resolved_in_time");
  });

  it("does not escalate when the session already left HUMAN mode (e.g. released back to AI)", () => {
    const result = decideEscalation({ mode: "AI", last_sender: "ai", handoff_at: "x" }, 5);
    expect(result.outcome).toBe("resolved_in_time");
  });

  it("does not escalate when the session row no longer exists", () => {
    const result = decideEscalation(null, 5);
    expect(result.outcome).toBe("resolved_in_time");
  });
});

describe("workflows/slaEscalationWorkflow notifyEscalation", () => {
  it("reports not notified when no webhook is configured (honest, no silent failure)", async () => {
    const result = await notifyEscalation({ DB: {} as any }, { id: "sla-1", sessionId: "s1", reason: "x" });
    expect(result.notified).toBe(false);
  });

  it("posts to the configured webhook and reports notified:true on success", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await notifyEscalation(
      { DB: {} as any, SLA_NOTIFY_WEBHOOK_URL: "https://example.test/webhook" },
      { id: "sla-1", sessionId: "s1", reason: "CS belum merespons" },
    );
    expect(result.notified).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("https://example.test/webhook", expect.anything());
    vi.unstubAllGlobals();
  });

  it("degrades gracefully (notified:false) when the webhook call throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const result = await notifyEscalation(
      { DB: {} as any, SLA_NOTIFY_WEBHOOK_URL: "https://example.test/webhook" },
      { id: "sla-1", sessionId: "s1", reason: "x" },
    );
    expect(result.notified).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe("workflows routes", () => {
  function fakeEnv(overrides: Partial<any> = {}) {
    return {
      FEATURE_SLA_WORKFLOW: "true",
      SLA_MINUTES: "5",
      DB: {
        prepare: vi.fn(() => ({
          bind: vi.fn().mockReturnThis(),
          all: vi.fn(async () => ({ results: [] })),
        })),
      },
      SLA_WORKFLOW: { create: vi.fn(async () => ({ id: "wf-1" })) },
      ...overrides,
    };
  }

  it("starts a workflow instance with the resolved sessionId/slaMinutes", async () => {
    const app = buildSlaRoutes();
    const env = fakeEnv();
    const res = await app.request("/sla/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "sess-abc" }),
    }, env as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.started).toBe(true);
    expect(env.SLA_WORKFLOW.create).toHaveBeenCalledWith({ params: { sessionId: "sess-abc", slaMinutes: 5 } });
  });

  it("rejects /sla/start without a sessionId", async () => {
    const app = buildSlaRoutes();
    const res = await app.request("/sla/start", { method: "POST", body: "{}" }, fakeEnv() as any);
    expect(res.status).toBe(400);
  });

  it("returns 404 when FEATURE_SLA_WORKFLOW is disabled", async () => {
    const app = buildSlaRoutes();
    const res = await app.request("/sla/escalations", {}, fakeEnv({ FEATURE_SLA_WORKFLOW: "false" }) as any);
    expect(res.status).toBe(404);
  });
});
