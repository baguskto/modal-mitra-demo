import { useEffect, useRef, useState } from "react";
import { approveHitl, connectCsSocket, getAuditLog, listHitlPending, listKillSwitches, listQueue, listSessions, rejectHitl, setKillSwitch, tamperDemo, verifyAudit } from "./api";
import { CS_IDENTITIES } from "./csIdentities";
import { renderInlineMarkdown } from "./markdown";

const WRITE_TOOLS = ["create_complaint_ticket", "create_dsr_request", "create_restructuring_request", "handoff_to_human"];
const CS_IDENTITY_STORAGE_KEY = "mmk_cs_identity";

interface Msg {
  role: "user" | "ai" | "human" | "system";
  text: string;
  citations?: string[];
  ts: string;
}

function slaBadge(slaDueAt: string | null) {
  if (!slaDueAt) return null;
  const msLeft = new Date(slaDueAt).getTime() - Date.now();
  const overdue = msLeft < 0;
  const minutes = Math.abs(Math.round(msLeft / 60000));
  return (
    <span className={`sla-badge ${overdue ? "overdue" : minutes <= 2 ? "warn" : "ok"}`}>
      {overdue ? `SLA lewat ${minutes}m` : `SLA ${minutes}m`}
    </span>
  );
}

export default function CsConsole({ presenter, mySessionId }: { presenter: boolean; mySessionId?: string }) {
  const [queue, setQueue] = useState<any[]>([]);
  const [killSwitches, setKillSwitches] = useState<any[]>([]);
  const [allSessions, setAllSessions] = useState<any[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeMeta, setActiveMeta] = useState<any>(null);
  const [history, setHistory] = useState<Msg[]>([]);
  const [mode, setMode] = useState<"AI" | "HUMAN">("AI");
  const [handoffSummary, setHandoffSummary] = useState<string | null>(null);
  const [customerTyping, setCustomerTyping] = useState(false);
  const [reply, setReply] = useState("");
  const [auditResult, setAuditResult] = useState<any>(null);
  const [auditLog, setAuditLog] = useState<any[]>([]);
  const [hitlPending, setHitlPending] = useState<any[]>([]);
  // FIX (temuan QA M5/m6): identitas approver dipilih dari dropdown (akun CS demo TETAP), bukan
  // diketik bebas via window.prompt() -- persist per tab via sessionStorage, mirip "login" CS demo.
  const [csIdentityId, setCsIdentityId] = useState<string>(() => sessionStorage.getItem(CS_IDENTITY_STORAGE_KEY) ?? CS_IDENTITIES[0].id);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    sessionStorage.setItem(CS_IDENTITY_STORAGE_KEY, csIdentityId);
  }, [csIdentityId]);

  async function refreshLists() {
    setQueue(await listQueue(mySessionId));
    setAllSessions(await listSessions(mySessionId));
    setHitlPending(await listHitlPending());
  }

  useEffect(() => {
    refreshLists();
    const t = setInterval(refreshLists, 4000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (presenter) listKillSwitches().then(setKillSwitches);
  }, [presenter]);

  // FIX (temuan QA M5): approver = identitas yang DIPILIH (csIdentityId), bukan window.prompt().
  // Server (src/index.ts) menolak id yang tidak ada di daftar & id yang sama dengan approver pertama.
  async function approveWithIdentity(restruId: string) {
    const res = await approveHitl(restruId, csIdentityId);
    if (res?.error) window.alert(res.error);
    refreshLists();
  }

  // FIX (temuan QA m6): alasan tolak lewat textarea inline (dibuka per-item), bukan window.prompt().
  function openRejectBox(restruId: string) {
    setRejectingId(restruId);
    setRejectReason("");
  }
  async function submitReject() {
    if (!rejectingId) return;
    await rejectHitl(rejectingId, rejectReason || undefined);
    setRejectingId(null);
    setRejectReason("");
    refreshLists();
  }

  async function toggleTool(tool: string, currentlyDisabled: boolean) {
    await setKillSwitch(tool, !currentlyDisabled);
    setKillSwitches(await listKillSwitches());
  }

  function openSession(id: string) {
    setActiveId(id);
    setHistory([]);
    setAuditResult(null);
    getAuditLog(id, mySessionId).then(setAuditLog);
    wsRef.current?.close();
    const ws = connectCsSocket(id);
    wsRef.current = ws;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "init") {
        setHistory(msg.history ?? []);
        setMode(msg.mode ?? "AI");
        setHandoffSummary(msg.handoffSummary ?? null);
        setActiveMeta({ persona: msg.persona, verifiedActorId: msg.verifiedActorId, handoffAt: msg.handoffAt });
      } else if (msg.type === "message") {
        setHistory((h) => [...h, { role: msg.role, text: msg.text, citations: msg.citations, ts: msg.ts }]);
        if (msg.role === "ai" || msg.role === "user") setCustomerTyping(false);
      } else if (msg.type === "retracted") {
        setHistory((h) => [...h, { role: "ai", text: `${msg.text} [dikoreksi guardrail: ${msg.blockedByGuard}]`, citations: msg.citations, ts: msg.ts }]);
      } else if (msg.type === "token") {
        // Token individual tidak ditampilkan di konsol CS (CS melihat hasil final per bubble),
        // cukup indikator ai_typing_start/end untuk tahu AI sedang menyusun jawaban.
      } else if (msg.type === "typing" && msg.role === "customer") {
        setCustomerTyping(!!msg.isTyping);
      } else if (msg.type === "mode_change") {
        setMode(msg.mode);
        setHandoffSummary(msg.summary ?? null);
      }
    };
  }

  useEffect(() => () => wsRef.current?.close(), []);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history]);

  // FIX (P0 "tombol banyak error"): klik Takeover/Kembalikan/Kirim tepat setelah membuka sesi bisa
  // kena race — WS baru dibuat di openSession() belum readyState OPEN (masih CONNECTING) saat
  // tombol diklik -> ws.send() lempar InvalidStateError TANPA tertangkap (uncaught exception di
  // console). Semua pengiriman lewat socket CS sekarang lewat helper ini yang mengecek readyState.
  function sendCs(payload: any): boolean {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  function sendCsReply() {
    if (!reply.trim()) return;
    if (sendCs({ type: "cs_message", text: reply })) setReply("");
  }

  return (
    <div className="console">
      <div className="session-list">
        {presenter && (
          <div style={{ padding: 8, borderBottom: "1px solid #2a3850" }}>
            <div className="queue-heading" style={{ marginBottom: 4 }}>🛡️ Kill-switch per tool (admin, Presenter)</div>
            {WRITE_TOOLS.map((tool) => {
              const row = killSwitches.find((k) => k.tool_name === tool);
              const disabled = !!row?.disabled;
              return (
                <div key={tool} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, padding: "3px 0" }}>
                  <span>{tool}</span>
                  <button onClick={() => toggleTool(tool, disabled)} style={{ color: disabled ? "#ff6b6b" : "#6bdc8a" }}>
                    {disabled ? "DIMATIKAN — nyalakan" : "aktif — matikan"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <div className="queue-heading">🔒 Persetujuan HITL — four-eyes ({hitlPending.length})</div>
        {presenter && (
          <div style={{ padding: "0 14px 8px", fontSize: 11 }}>
            🧑‍💼 Masuk sebagai (CS demo):{" "}
            <select value={csIdentityId} onChange={(e) => setCsIdentityId(e.target.value)}>
              {CS_IDENTITIES.map((i) => (
                <option key={i.id} value={i.id}>{i.name}</option>
              ))}
            </select>
          </div>
        )}
        {hitlPending.length === 0 && <div className="empty-hint">Tidak ada permintaan restrukturisasi menunggu.</div>}
        {hitlPending.map((h) => {
          const firstApproverName = CS_IDENTITIES.find((i) => i.id === h.first_approver)?.name ?? h.first_approver;
          return (
          <div key={h.restru_id} className="session-item" style={{ borderLeft: "3px solid #e0a800" }}>
            <div><b>{h.restru_id}</b> · {h.mitra_id} ({h.pinjaman_no})</div>
            <div className="sub">{h.reason?.slice(0, 80)}</div>
            {h.status === "approved_once" && (
              <div className="sub" style={{ color: "#8a5a00" }}>✅ Disetujui oleh {firstApproverName} — menunggu approver KE-2 yang berbeda.</div>
            )}
            {presenter ? (
              rejectingId === h.restru_id ? (
                <div style={{ marginTop: 4 }}>
                  <textarea
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder="Alasan tolak (opsional)..."
                    style={{ width: "100%", fontSize: 11, minHeight: 40 }}
                  />
                  <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                    <button onClick={submitReject}>Kirim tolak</button>
                    <button onClick={() => setRejectingId(null)}>Batal</button>
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                  <button onClick={() => approveWithIdentity(h.restru_id)}>Setujui sbg {CS_IDENTITIES.find((i) => i.id === csIdentityId)?.name}</button>
                  <button onClick={() => openRejectBox(h.restru_id)}>Tolak</button>
                </div>
              )
            ) : (
              <div className="sub" style={{ opacity: 0.7, marginTop: 4 }}>Setujui/Tolak khusus mode Presenter (four-eyes)</div>
            )}
          </div>
          );
        })}
        <div className="queue-heading">🔥 Antrean handoff ({queue.length})</div>
        {queue.length === 0 && <div className="empty-hint">Tidak ada sesi menunggu CS.</div>}
        {queue.map((s) => (
          <div key={s.session_id} className={`session-item queue ${activeId === s.session_id ? "active" : ""}`} onClick={() => openSession(s.session_id)}>
            <div><b>{s.session_id}</b> {slaBadge(s.sla_due_at)}</div>
            <div className="sub">{s.persona} · {s.handoff_summary || s.last_message}</div>
          </div>
        ))}
        <div className="queue-heading">{presenter ? "Semua sesi" : "Sesi saya"}</div>
        {!presenter && allSessions.length === 0 && <div className="empty-hint">Sesi Anda belum tercatat (kirim pesan dulu di Live Chat).</div>}
        {allSessions.map((s) => (
          <div key={s.session_id} className={`session-item ${activeId === s.session_id ? "active" : ""}`} onClick={() => openSession(s.session_id)}>
            <div><b>{s.session_id}</b> <span className={`badge ${s.mode}`}>{s.mode}</span></div>
            <div className="sub">{s.persona} · {s.last_message}</div>
          </div>
        ))}
      </div>
      <div className="console-detail">
        {!activeId && <div className="empty-hint" style={{ padding: 20 }}>Pilih sesi di kiri untuk melihat percakapan live & mengambil alih.</div>}
        {activeId && (
          <>
            <div className="console-topbar">
              <b>{activeId}</b> · persona: {activeMeta?.persona ?? "-"} · actor: {activeMeta?.verifiedActorId ?? "belum terverifikasi"}
              {customerTyping && <span className="typing-live"> · pengguna sedang mengetik...</span>}
            </div>
            {mode === "HUMAN" && handoffSummary && <div className="wa-handoff-banner">Ringkasan handoff: {handoffSummary}</div>}
            <div className="messages">
              {history.map((m, i) => (
                <div key={i} className={`msg ${m.role}`}>
                  {renderInlineMarkdown(m.text)}
                  {m.citations && m.citations.length > 0 && <div className="citations">Sumber: {m.citations.join(", ")}</div>}
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
            <div className="cs-actions">
              {presenter ? (
                <>
                  <button onClick={() => sendCs({ type: "takeover" })}>Ambil Alih (Takeover)</button>
                  <button onClick={() => sendCs({ type: "release" })}>Kembalikan ke AI</button>
                </>
              ) : (
                <button
                  title="Takeover/balas CS khusus mode Presenter — di sini kamu bisa reset sesi demo kamu sendiri"
                  onClick={() => { sessionStorage.removeItem("mmk_session_id"); window.location.reload(); }}
                >
                  🔄 Reset sesi demo
                </button>
              )}
              <button onClick={() => verifyAudit(activeId, mySessionId).then(setAuditResult)}>🔍 Verifikasi integritas log (hash-chain+HMAC)</button>
              {presenter && (
                <button style={{ color: "#ff6b6b" }} onClick={() => tamperDemo(activeId).then(() => window.alert("1 baris di-tamper. Klik 'Verifikasi integritas log' untuk lihat terdeteksi."))}>
                  ⚠️ Demo tamper 1 baris (Presenter)
                </button>
              )}
            </div>
            {presenter && mode === "HUMAN" && (
              <div className="input-row">
                <input value={reply} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendCsReply()} placeholder="Balas sebagai CS..." />
                <button onClick={sendCsReply}>Kirim</button>
              </div>
            )}
            {auditResult && (
              <div style={{ padding: 10, fontSize: 12, background: auditResult.valid ? "#d7f2e3" : "#fde2e1" }}>
                Hash-chain {auditResult.valid ? "VALID (tidak ada tampering terdeteksi)" : `RUSAK di seq ${auditResult.brokenAtSeq}`} · HMAC {auditResult.hmacEnabled ? "aktif" : "TIDAK aktif (fallback SHA-256 polos)"}
              </div>
            )}
            <details style={{ padding: 10, fontSize: 11, color: "#555" }}>
              <summary>Trace audit log ({auditLog.length} event)</summary>
              <pre style={{ maxHeight: 200, overflow: "auto" }}>{JSON.stringify(auditLog, null, 2)}</pre>
            </details>
          </>
        )}
      </div>
    </div>
  );
}
