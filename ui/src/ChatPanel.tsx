import { useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { DemoLink } from "./learn/types";

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

function textOfParts(parts: any[]): string {
  return (parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("");
}
function metaOfParts(parts: any[]): any {
  return (parts ?? []).find((p) => p.type === "data-meta")?.data ?? null;
}

// Migrasi dari WebSocket kustom manual (lihat tag git `v1-pre-agents-sdk`, ui/src/ChatPanel.tsx)
// ke `useAgent`+`useAgentChat` (Cloudflare Agents SDK) — persistensi pesan & resumable streaming
// otomatis dari server (src/do/ChatAgent.ts). Event non-chat (init/mode_change/typing CS) tetap
// lewat `onMessage` kustom di koneksi yang SAMA (protokol kustom ringan, lihat ChatAgent.ts).
export default function ChatPanel({
  sessionId,
  pendingDemo,
  onDemoConsumed,
}: {
  sessionId: string;
  pendingDemo?: DemoLink | null;
  onDemoConsumed?: () => void;
}) {
  const [persona, setPersona] = useState<Persona>("mitra");
  const [personaLocked, setPersonaLocked] = useState(false);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"AI" | "HUMAN">("AI");
  const [humanTyping, setHumanTyping] = useState(false);
  const [connected, setConnected] = useState(false);
  const [handoffSummary, setHandoffSummary] = useState<string | null>(null);
  const [demoHint, setDemoHint] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<number | undefined>(undefined);
  const consumedDemoRef = useRef<DemoLink | null>(null);

  const agent = useAgent({
    agent: "ChatAgent",
    basePath: `api/chat/${encodeURIComponent(sessionId)}/ws`,
    onOpen: () => setConnected(true),
    onClose: () => setConnected(false),
    onMessage: (event: MessageEvent) => {
      let msg: any;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "init") {
        setMode(msg.mode ?? "AI");
        if (msg.persona) {
          setPersona(msg.persona);
          if ((msg.history ?? []).length > 0) setPersonaLocked(true);
        }
        setHandoffSummary(msg.handoffSummary ?? null);
      } else if (msg.type === "mode_change") {
        setMode(msg.mode);
        setHandoffSummary(msg.mode === "HUMAN" ? (msg.summary ?? null) : null);
      } else if (msg.type === "typing" && msg.role === "cs") {
        setHumanTyping(!!msg.isTyping);
      }
    },
  });

  const { messages, sendMessage, status } = useAgentChat({ agent, body: () => ({ persona }) });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  // Datang dari halaman /learn ("Lihat di demo" / "Coba serang") -> kirim pesan nyata
  // (bukan rekaman) sekali saja per klik, lalu tampilkan hint singkat apa yang perlu diperhatikan.
  useEffect(() => {
    if (!pendingDemo || consumedDemoRef.current === pendingDemo) return;
    consumedDemoRef.current = pendingDemo;
    send(pendingDemo.autosend);
    setDemoHint(
      pendingDemo.redteam
        ? `${pendingDemo.watchFor} (Red Team Arena penuh dengan X-Ray menyusul setelah modul keamanan digabung — untuk sekarang, kirim langsung ke chat ini.)`
        : pendingDemo.watchFor,
    );
    onDemoConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDemo]);

  function notifyTyping(isTyping: boolean) {
    try {
      (agent as any).send?.(JSON.stringify({ type: "typing", isTyping }));
    } catch {
      // koneksi belum siap, aman diabaikan
    }
  }

  function onInputChange(v: string) {
    setInput(v);
    notifyTyping(true);
    window.clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = window.setTimeout(() => notifyTyping(false), 1500);
  }

  function send(text?: string) {
    const payload = (text ?? input).trim();
    if (!payload || mode === "HUMAN") return;
    sendMessage({ role: "user", parts: [{ type: "text", text: payload }] } as any);
    setPersonaLocked(true);
    setInput("");
    notifyTyping(false);
  }

  const aiTyping = status === "submitted" || status === "streaming";

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

      {demoHint && (
        <div className="wa-demo-hint">
          💡 {demoHint}
          <button onClick={() => setDemoHint(null)} aria-label="Tutup">✕</button>
        </div>
      )}

      <div className="wa-messages">
        {messages.length === 0 && (
          <div className="wa-quickfill">
            <div className="hint">Coba skenario demo:</div>
            {QUICK_FILL[persona].map((q) => (
              <button key={q.label} onClick={() => send(q.text)}>{q.label}</button>
            ))}
          </div>
        )}
        {messages.map((m: any, i) => {
          const isUser = m.role === "user";
          const isHuman = m.role === "assistant" && m.metadata?.source === "human";
          const text = textOfParts(m.parts);
          const meta = metaOfParts(m.parts);
          const roleClass = isUser ? "user" : isHuman ? "human" : "ai";
          return (
            <div key={m.id ?? i} className={`wa-bubble-row ${isUser ? "out" : "in"}`}>
              <div className={`wa-bubble ${roleClass} ${meta?.blockedByGuard ? "guarded" : ""}`}>
                {text}
                {meta?.citations?.length > 0 && <div className="wa-citations">Sumber: {meta.citations.join(", ")}</div>}
              </div>
            </div>
          );
        })}
        {aiTyping && (
          <div className="wa-bubble-row in">
            <div className="wa-bubble ai">
              <span className="wa-typing-dots"><span /><span /><span /></span>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

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
