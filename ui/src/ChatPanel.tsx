import { useEffect, useRef, useState } from "react";
import { connectChatSocket } from "./api";

interface Msg {
  role: "user" | "ai" | "human" | "system";
  text: string;
  citations?: string[];
  ts: string;
  pending?: boolean;
  blockedByGuard?: string;
}

type Persona = "mitra" | "pendana";

const QUICK_FILL: Record<Persona, { label: string; text: string }[]> = {
  mitra: [
    { label: "Verifikasi Sri Wahyuni", text: "Cek sisa angsuran saya, nomor pinjaman MMK-100001 tanggal lahir saya 1985-03-12" },
    { label: "Jadwal majelis", text: "kapan pertemuan majelis saya selanjutnya" },
    { label: "Telat bayar", text: "aduh maap bu kemarin blm bisa bayar angsuran, gimana ya" },
  ],
  pendana: [
    { label: "Verifikasi Andi Pratama", text: "Cek portofolio pendanaan saya, ID pendana PND-0001 tanggal lahir saya 1992-01-15" },
    { label: "Tanya risiko", text: "imbal hasil pendanaan di sini dijamin ga sih" },
  ],
};

export default function ChatPanel({ sessionId }: { sessionId: string }) {
  const [persona, setPersona] = useState<Persona>("mitra");
  const [personaLocked, setPersonaLocked] = useState(false);
  const [history, setHistory] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"AI" | "HUMAN">("AI");
  const [aiTyping, setAiTyping] = useState(false);
  const [humanTyping, setHumanTyping] = useState(false);
  const [connected, setConnected] = useState(false);
  const [handoffSummary, setHandoffSummary] = useState<string | null>(null);
  const [lastTiming, setLastTiming] = useState<{ firstTokenMs: number | null; totalMs: number } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const typingTimeoutRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const ws = connectChatSocket(sessionId);
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "init") {
        setHistory(msg.history ?? []);
        setMode(msg.mode ?? "AI");
        if (msg.persona) {
          setPersona(msg.persona);
          if ((msg.history ?? []).length > 0) setPersonaLocked(true);
        }
        setHandoffSummary(msg.handoffSummary ?? null);
      } else if (msg.type === "message") {
        setHistory((h) => {
          const withoutPending = h.filter((m) => !m.pending);
          return [...withoutPending, { role: msg.role, text: msg.text, citations: msg.citations, ts: msg.ts }];
        });
        if (msg.role === "ai") setLastTiming(msg.timing ?? null);
        if (msg.role !== "system") setAiTyping(false);
      } else if (msg.type === "retracted") {
        setHistory((h) => {
          const withoutPending = h.filter((m) => !m.pending);
          return [...withoutPending, { role: "ai", text: msg.text, citations: msg.citations, ts: msg.ts, blockedByGuard: msg.blockedByGuard }];
        });
        setAiTyping(false);
      } else if (msg.type === "ai_typing_start") {
        setAiTyping(true);
        setHistory((h) => [...h, { role: "ai", text: "", ts: new Date().toISOString(), pending: true }]);
      } else if (msg.type === "ai_typing_end") {
        setAiTyping(false);
      } else if (msg.type === "token") {
        setHistory((h) => {
          if (h.length === 0 || !h[h.length - 1].pending) return h;
          const copy = [...h];
          copy[copy.length - 1] = { ...copy[copy.length - 1], text: copy[copy.length - 1].text + msg.text };
          return copy;
        });
      } else if (msg.type === "typing" && msg.role === "cs") {
        setHumanTyping(!!msg.isTyping);
      } else if (msg.type === "mode_change") {
        setMode(msg.mode);
        if (msg.mode === "HUMAN") setHandoffSummary(msg.summary ?? null);
        else setHandoffSummary(null);
      }
    };
    return () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history, aiTyping]);

  function notifyTyping(isTyping: boolean) {
    wsRef.current?.readyState === WebSocket.OPEN && wsRef.current.send(JSON.stringify({ type: "typing", isTyping }));
  }

  function onInputChange(v: string) {
    setInput(v);
    notifyTyping(true);
    window.clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = window.setTimeout(() => notifyTyping(false), 1500);
  }

  function send(text?: string) {
    const payload = (text ?? input).trim();
    if (!payload || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "user_message", text: payload, persona }));
    setPersonaLocked(true);
    setInput("");
    notifyTyping(false);
  }

  return (
    <div className="wa-shell">
      <div className="wa-header">
        <div className="wa-avatar">MM</div>
        <div className="wa-header-info">
          <div className="wa-title">Modal Mitra Contoh · Asisten AI</div>
          <div className="wa-subtitle">
            {connected ? (mode === "HUMAN" ? "Ditangani CS" : "online") : "menyambungkan..."}
            {humanTyping && " · CS sedang mengetik..."}
          </div>
        </div>
        <div className="wa-persona-toggle">
          {(["mitra", "pendana"] as Persona[]).map((p) => (
            <button key={p} className={persona === p ? "active" : ""} disabled={personaLocked} onClick={() => setPersona(p)}>
              {p === "mitra" ? "Mitra" : "Pendana"}
            </button>
          ))}
        </div>
      </div>

      <div className="wa-banner">
        Demo fiktif · data sintetis · persona: <b>{persona === "mitra" ? "Mitra (peminjam)" : "Pendana (penyalur dana)"}</b>
        {personaLocked && " (terkunci untuk sesi ini)"}
      </div>

      {mode === "HUMAN" && handoffSummary && (
        <div className="wa-handoff-banner">🧑‍💼 Dialihkan ke CS manusia. Ringkasan otomatis: {handoffSummary}</div>
      )}

      <div className="wa-messages">
        {history.length === 0 && (
          <div className="wa-quickfill">
            <div className="hint">Coba skenario demo:</div>
            {QUICK_FILL[persona].map((q) => (
              <button key={q.label} onClick={() => send(q.text)}>{q.label}</button>
            ))}
          </div>
        )}
        {history.map((m, i) => (
          <div key={i} className={`wa-bubble-row ${m.role === "user" ? "out" : "in"}`}>
            <div className={`wa-bubble ${m.role} ${m.blockedByGuard ? "guarded" : ""}`}>
              {m.pending && m.text === "" ? (
                <span className="wa-typing-dots"><span /><span /><span /></span>
              ) : (
                <>
                  {m.text}
                  {m.citations && m.citations.length > 0 && <div className="wa-citations">Sumber: {m.citations.join(", ")}</div>}
                </>
              )}
              <div className="wa-ts">{new Date(m.ts).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}</div>
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {lastTiming && (
        <div className="wa-latency">
          ⚡ first token {lastTiming.firstTokenMs ?? "-"}ms · total {lastTiming.totalMs}ms
        </div>
      )}

      <div className="wa-input-row">
        <input
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={mode === "HUMAN" ? "CS sedang menangani percakapan ini..." : "Tulis pesan..."}
        />
        <button onClick={() => send()}>Kirim</button>
      </div>
    </div>
  );
}
