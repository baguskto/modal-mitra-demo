import { useMemo, useState, type ReactNode } from "react";

// X-Ray detail per fase (feat/latency-xray). Sumber data: event `xray_event` live (broadcast WS) ATAU
// `metadata.xray` yang tersimpan di pesan asisten (replay). Skema `XrayEvent` tidak berubah
// ({node, phase, ts, durationMs?, data}); detail per fase ada di `data` (technique/calls/rag/react/
// guards) — dibentuk server dari data yang SUDAH di-mask (src/obs/xrayDetail.ts), tanpa teks prompt.

export interface XrayEv {
  node: string;
  phase: "start" | "end";
  ts: string;
  durationMs?: number;
  data: any;
}

const PHASES = ["lang_detect", "guard_in", "llama_guard", "verify_identity", "route_intent", "tools", "guard_out", "respond"] as const;
const LABEL: Record<string, string> = {
  lang_detect: "0· Deteksi bahasa",
  guard_in: "1· Guard In",
  llama_guard: "1b· Llama Guard (paralel)",
  verify_identity: "2· Verify",
  route_intent: "3· Route Intent",
  tools: "4· Tools (RAG · tool · LLM)",
  guard_out: "5· Guard Out (streaming)",
  respond: "6· Respond",
};

interface PhaseView {
  node: string;
  startMs: number;
  durationMs: number;
  status: "idle" | "running" | "done" | "blocked" | "skip";
  data: any;
}

function summary(node: string, d: any): string {
  if (!d) return "";
  if (d.blocked) return `🚫 diblok: ${d.layer ?? d.reason ?? "guard"}`;
  switch (node) {
    case "lang_detect":
      return `${d.language ?? "-"}${typeof d.confidence === "number" ? ` (${Math.round(d.confidence * 100)}%)` : ""}`;
    case "guard_in":
      return `lolos · ${d.piiRedactedCount ?? 0} PII diredaksi${d.parallel ? ` · paralel: ${d.parallel.length}` : ""}`;
    case "llama_guard":
      return d.calls?.[0]?.result ?? "selesai";
    case "verify_identity":
      return d.verified ? "terverifikasi ✓" : d.skipped ? "dilewati" : "tidak cocok";
    case "route_intent":
      return `intent: ${d.intent ?? "-"}${d.handoff ? " · HANDOFF" : ""}${d.intentSource ? ` (${d.intentSource})` : ""}`;
    case "tools": {
      const tools = (d.calls ?? []).filter((c: any) => c.kind === "tool").length;
      const docs = (d.rag?.docs ?? []).filter((x: any) => x.kept).length;
      return `${d.refused ? "🛡️ LLM menolak · " : ""}${docs} dok · ${tools} tool · ${d.react?.steps ? `ReAct ${d.react.steps.length} langkah` : "tanpa ReAct"} · ${d.model ?? ""}`;
    }
    case "guard_out":
      if (d.skipped) return "dilewati";
      return `${d.sentencesShown ?? 0}/${d.sentencesChecked ?? 0} kalimat lolos${d.replaced ? " · bubble diganti" : ""}`;
    case "respond":
      return `first-token ${d.firstTokenMs ?? "-"} ms · total ${d.totalMs ?? "-"} ms`;
    default:
      return "selesai";
  }
}

function buildPhases(events: XrayEv[]): { phases: PhaseView[]; t0: number; total: number } {
  if (events.length === 0) return { phases: [], t0: 0, total: 0 };
  const t0 = Math.min(...events.map((e) => new Date(e.ts).getTime() - (e.phase === "end" ? e.durationMs ?? 0 : 0)));
  const byNode = new Map<string, PhaseView>();
  for (const e of events) {
    const at = new Date(e.ts).getTime();
    const cur = byNode.get(e.node);
    if (e.phase === "start") {
      if (!cur) byNode.set(e.node, { node: e.node, startMs: at - t0, durationMs: 0, status: "running", data: e.data });
      continue;
    }
    const startMs = cur && cur.status === "running" ? cur.startMs : at - t0 - (e.durationMs ?? 0);
    const merged = cur && cur.status !== "running" ? { ...cur.data, ...e.data, calls: [...(cur.data?.calls ?? []), ...(e.data?.calls ?? [])] } : e.data;
    const status: PhaseView["status"] = merged?.blocked ? "blocked" : merged?.skipped && !merged?.verified ? "skip" : "done";
    byNode.set(e.node, { node: e.node, startMs: cur ? Math.min(cur.startMs, startMs) : startMs, durationMs: cur && cur.status !== "running" ? cur.durationMs : e.durationMs ?? 0, status, data: merged });
  }
  const phases = [...byNode.values()].sort((a, b) => {
    const ia = PHASES.indexOf(a.node as any);
    const ib = PHASES.indexOf(b.node as any);
    if (ia === -1 && ib === -1) return a.startMs - b.startMs;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  const total = Math.max(1, ...phases.map((p) => p.startMs + p.durationMs));
  return { phases, t0, total };
}

function Chip({ kind, children }: { kind: string; children: ReactNode }) {
  return <span className={`xr-chip ${kind}`}>{children}</span>;
}

function PhaseDetail({ p, citedIds }: { p: PhaseView; citedIds: Set<string> }) {
  const d = p.data ?? {};
  return (
    <div className="xr-detail">
      {d.technique?.length > 0 && (
        <div className="xr-sec">
          <div className="xr-sec-title">Teknik</div>
          {d.technique.map((t: any, i: number) => (
            <div key={i} className="xr-tech">
              <b>{t.label}</b>
              <span>{t.desc}</span>
            </div>
          ))}
        </div>
      )}
      {d.calls?.length > 0 && (
        <div className="xr-sec">
          <div className="xr-sec-title">Model / tool dipanggil</div>
          {d.calls.map((c: any, i: number) => (
            <div key={i} className="xr-call">
              <div className="xr-call-head">
                <Chip kind={c.kind}>{c.kind}</Chip>
                <b>{c.name}</b>
                <span className="xr-dim">{c.ms !== undefined ? `${c.ms} ms` : ""}{c.atMs !== undefined ? ` · @+${c.atMs} ms` : ""}</span>
              </div>
              {c.args && <div className="xr-kv"><span>arg</span><code>{c.args}</code></div>}
              {c.result && <div className="xr-kv"><span>hasil</span>{c.result}</div>}
              {(c.tokIn !== undefined || c.tokOut !== undefined) && <div className="xr-kv"><span>token</span>in {c.tokIn ?? "-"} · out {c.tokOut ?? "-"}</div>}
            </div>
          ))}
        </div>
      )}
      {d.rag && (
        <div className="xr-sec">
          <div className="xr-sec-title">RAG · {d.rag.method === "vector" ? "vektor" : "BM25 (fallback)"} · {d.rag.ms} ms{d.rag.embedMs !== undefined ? ` (embed ${d.rag.embedMs} + query ${d.rag.queryMs})` : ""}{d.rag.waitedMs !== undefined ? ` · ditunggu ${d.rag.waitedMs} ms` : ""}</div>
          {d.rag.query && <div className="xr-kv"><span>kueri</span><code>{d.rag.query}</code></div>}
          <table className="xr-docs">
            <tbody>
              {(d.rag.docs ?? []).map((doc: any) => (
                <tr key={doc.id} className={doc.kept ? "" : "xr-dim"}>
                  <td><code>{doc.id}</code></td>
                  <td>{doc.score}</td>
                  <td>{citedIds.has(String(doc.id).toLowerCase()) ? <Chip kind="ok">dikutip</Chip> : doc.kept ? "konteks" : "di bawah ambang"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d.react && (
        <div className="xr-sec">
          <div className="xr-sec-title">ReAct</div>
          {d.react.skipped && <div className="xr-dim">{d.react.skipped}</div>}
          {(d.react.steps ?? []).map((s: any) => (
            <div key={s.step} className="xr-react">
              <div><b>#{s.step}</b> {s.thought ? <>Thought: <i>{s.thought}</i></> : <span className="xr-dim">Thought: (tidak dilaporkan model)</span>}</div>
              <div>→ Action: <code>{s.action}</code>{s.args ? <> <code className="xr-dim">{s.args}</code></> : null}</div>
              <div>→ Observation: {s.observation ?? "-"}{s.ms !== undefined ? <span className="xr-dim"> · {s.ms} ms</span> : null}</div>
            </div>
          ))}
        </div>
      )}
      {d.stream && (
        <div className="xr-sec">
          <div className="xr-sec-title">Streaming</div>
          <div className="xr-kv"><span>pemenang</span>{d.stream.winner}{d.stream.hedged ? " (balapan)" : ""}</div>
          {d.stream.reason && <div className="xr-kv"><span>alasan</span>{d.stream.reason}</div>}
          {d.stream.candidates && <div className="xr-kv"><span>kandidat</span><code>{d.stream.candidates.join(" · ")}</code></div>}
          {d.stream.workersAiBudget && <div className="xr-kv"><span>kuota WAI</span>{d.stream.workersAiBudget.neuronsToday}/{d.stream.workersAiBudget.raceCap} neuron hari ini · balapan {d.stream.workersAiBudget.raceEnabled ? "aktif" : "mati (cap biaya nol)"}</div>}
          {d.stream.ttftMs !== undefined && <div className="xr-kv"><span>token pertama model</span>{d.stream.ttftMs} ms sejak panggilan</div>}
        </div>
      )}
      {d.guards?.length > 0 && (
        <div className="xr-sec">
          <div className="xr-sec-title">Guardrail</div>
          {d.guards.map((g: any, i: number) => (
            <div key={i} className="xr-guard">
              <Chip kind={g.result}>{g.result}</Chip> {g.rule}
              {g.detail && <span className="xr-dim"> — {g.detail}</span>}
            </div>
          ))}
        </div>
      )}
      {d.note && <div className="xr-dim">{d.note}</div>}
    </div>
  );
}

export default function XrayPanel({ events, meta, presenter }: { events: XrayEv[]; meta: any; presenter: boolean }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const { phases, t0, total } = useMemo(() => buildPhases(events), [events]);
  const citedIds = useMemo(() => {
    const g = phases.find((p) => p.node === "guard_out");
    return new Set<string>((g?.data?.citedIds ?? meta?.citations ?? []).map((c: string) => c.toLowerCase()));
  }, [phases, meta]);
  const firstTokenMs: number | null = meta?.timing?.firstTokenMs ?? phases.find((p) => p.node === "respond")?.data?.firstTokenMs ?? null;
  const slowest = phases.filter((p) => p.node !== "guard_out").reduce<PhaseView | null>((a, p) => (!a || p.durationMs > a.durationMs ? p : a), null);
  const log = useMemo(() => [...events].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()), [events]);

  return (
    <div className="xray-panel" data-testid="xray-panel">
      <div className="xray-title">🩻 X-Ray — alur LangGraph per fase</div>
      {phases.length === 0 ? (
        <div className="xr-dim">Kirim pesan untuk melihat alur per fase (durasi, teknik, tool, RAG, guardrail).</div>
      ) : (
        <>
          <div className="xr-waterfall" aria-label="Waterfall durasi fase">
            <div className="xr-wf-axis">
              <span>0</span>
              <span>{total} ms</span>
            </div>
            {phases.map((p) => (
              <div key={p.node} className="xr-wf-row">
                <span className="xr-wf-label">{(LABEL[p.node] ?? p.node).replace(/^\d· /, "")}</span>
                <span className="xr-wf-track">
                  <span className={`xr-wf-bar ${p.status} ${slowest?.node === p.node ? "slowest" : ""}`} style={{ left: `${(100 * p.startMs) / total}%`, width: `${Math.max(1.2, (100 * p.durationMs) / total)}%` }} />
                  {firstTokenMs !== null && firstTokenMs > 0 && <span className="xr-wf-ft" style={{ left: `${Math.min(100, (100 * firstTokenMs) / total)}%` }} title={`first token ${firstTokenMs} ms`} />}
                </span>
                <span className="xr-wf-ms">{p.status === "running" ? "…" : `${p.durationMs}`}</span>
              </div>
            ))}
            <div className="xr-wf-legend">
              {firstTokenMs !== null && <span><i className="xr-wf-ft-dot" /> token pertama tampil @ {firstTokenMs} ms</span>}
              {slowest && <span>paling lambat: <b>{LABEL[slowest.node] ?? slowest.node}</b></span>}
            </div>
          </div>

          <div className="xray-pipeline">
            {phases.map((p) => {
              const isOpen = !!open[p.node];
              return (
                <div key={p.node} className={`xray-node ${p.status}`} data-node={p.node}>
                  <button className="xr-card-head" aria-expanded={isOpen} onClick={() => setOpen((o) => ({ ...o, [p.node]: !o[p.node] }))}>
                    <span className="xray-node-label">{LABEL[p.node] ?? p.node}</span>
                    <span className="xr-time">+{p.startMs} ms · {p.status === "running" ? "berjalan…" : `${p.durationMs} ms`}</span>
                    <span className="xr-caret">{isOpen ? "▾" : "▸"}</span>
                  </button>
                  <div className="xray-node-detail">{summary(p.node, p.data)}</div>
                  {isOpen && <PhaseDetail p={p} citedIds={citedIds} />}
                </div>
              );
            })}
          </div>
        </>
      )}

      {meta && (
        <div className="xray-meta">
          <div>Model: {meta.modelUsed}</div>
          <div>Intent: {meta.intent} {meta.blockedByGuard && `· diblokir: ${meta.blockedByGuard}`}</div>
          <div>Tools: {(meta.toolCallsMade ?? []).length} langkah{(meta.toolCallsMade ?? []).length ? ` (${meta.toolCallsMade.map((t: any) => t.tool).join(", ")})` : ""}</div>
          <div>Latensi: first-token {meta.timing?.firstTokenMs ?? "-"} ms · total {meta.timing?.totalMs ?? "-"} ms</div>
          {presenter && meta.traceId && <div className="xray-trace">Langfuse trace: <code>{meta.traceId}</code></div>}
        </div>
      )}

      <div className="xray-title" style={{ marginTop: 10 }}>Log event ({log.length}) — kronologis</div>
      <div className="xray-log">
        {log.map((e, i) => (
          <div key={i} className="xray-log-row">
            <span className="xray-log-t">+{Math.max(0, new Date(e.ts).getTime() - t0)}</span>
            <span className="xray-log-node">{e.node}</span>
            <span className="xray-log-phase">{e.phase === "start" ? "mulai" : `selesai ${e.durationMs ?? 0} ms`}</span>
            <span className="xray-log-data">{e.phase === "end" ? summary(e.node, e.data) : ""}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
