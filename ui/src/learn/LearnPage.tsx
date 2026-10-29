import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DemoLink } from "./types";
import { LEVELS } from "./levels";
import { FlowDiagram, CastleDiagram, MapDiagram } from "./Diagrams";
import "./learn.css";

interface LearnPageProps {
  presenter: boolean;
  onDemoLink: (demo: DemoLink) => void;
}

const SCREEN_COUNT = LEVELS.length + 1; // + penutup "Peta satu halaman"

function Diagram({ level }: { level: (typeof LEVELS)[number] }) {
  if (level.diagram.kind === "flow") return <FlowDiagram steps={level.diagram.steps} />;
  if (level.diagram.kind === "castle") return <CastleDiagram />;
  return <MapDiagram />;
}

function LevelCard({
  level,
  presenter,
  onDemoLink,
}: {
  level: (typeof LEVELS)[number];
  presenter: boolean;
  onDemoLink: (demo: DemoLink) => void;
}) {
  return (
    <article className="learn-card" id={`learn-level-${level.id}`}>
      <div className="learn-card-head">
        <span className="learn-badge">{level.index}</span>
        <h2>{level.title}</h2>
      </div>
      <p className="learn-analogy">"{level.analogy}"</p>
      <Diagram level={level} />
      {level.demo && (
        <div className="learn-demo">
          <button className={level.demo.redteam ? "learn-demo-btn danger" : "learn-demo-btn"} onClick={() => onDemoLink(level.demo!)}>
            {level.demo.redteam ? "🛡️ Coba serang" : "▶ Lihat di demo"}
          </button>
          <span className="learn-watch-for">{level.demo.watchFor}</span>
        </div>
      )}
      <div className="learn-wow">
        <span className="learn-wow-icon">✨</span>
        <div>
          <b>{level.wow}</b>
          <span className="learn-wow-source">{level.wowSource}</span>
        </div>
      </div>
      {presenter && (
        <div className="learn-qa">
          <div className="learn-qa-lock">🔒 Khusus Presenter — pertanyaan interview</div>
          <p className="learn-qa-q">Q: {level.interviewQ}</p>
          <p className="learn-qa-a">A: {level.interviewA}</p>
        </div>
      )}
    </article>
  );
}

function ClosingMap({ presenter }: { presenter: boolean }) {
  return (
    <article className="learn-card" id="learn-level-penutup">
      <div className="learn-card-head">
        <span className="learn-badge">∎</span>
        <h2>Peta satu halaman</h2>
      </div>
      <p className="learn-analogy">
        "Semua level di atas adalah satu alur yang sama: pesan masuk, dijaga, diverifikasi, diarahkan, dikerjakan, dijaga lagi, lalu dijawab."
      </p>
      <MapDiagram />
      <div className="learn-cheatsheet">
        <h3>Cheat sheet angka (semua nyata, lihat sumber masing-masing)</h3>
        <ul>
          {LEVELS.map((l) => (
            <li key={l.id}>
              <b>{typeof l.index === "number" ? `L${l.index}` : l.index}</b> {l.title}: {l.wow}
              <span className="learn-wow-source"> — {l.wowSource}</span>
            </li>
          ))}
        </ul>
      </div>
      {presenter && (
        <div className="learn-qa">
          <div className="learn-qa-lock">🔒 Khusus Presenter</div>
          <p className="learn-qa-a">
            Ringkasan 30 detik: demo ini LangGraph.js StateGraph di atas Cloudflare Agents SDK — guard_in (PII+injeksi) →
            verify_identity → route_intent (+ HITL four-eyes) → tools (RAG+ReAct, least-privilege) → guard_out
            (sitasi+privasi antar-majelis) → respond. Semua diukur: 42/45 eval, 0/11 red-team, trace per node di Langfuse.
            Bagian yang masih diusulkan (voice note, semantic cache, WhatsApp scale) ditandai jujur, bukan diklaim selesai.
          </p>
        </div>
      )}
    </article>
  );
}

export default function LearnPage({ presenter, onDemoLink }: LearnPageProps) {
  const [presentMode, setPresentMode] = useState(false);
  const [index, setIndex] = useState(0);
  const touchStartX = useRef<number | null>(null);

  const next = useCallback(() => setIndex((i) => Math.min(SCREEN_COUNT - 1, i + 1)), []);
  const prev = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  useEffect(() => {
    if (!presentMode) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === "Escape") setPresentMode(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [presentMode, next, prev]);

  const screens = useMemo(
    () => [
      ...LEVELS.map((l) => <LevelCard key={l.id} level={l} presenter={presenter} onDemoLink={onDemoLink} />),
      <ClosingMap key="penutup" presenter={presenter} />,
    ],
    [presenter, onDemoLink],
  );

  if (presentMode) {
    return (
      <div className="learn-page learn-present">
        <div
          className="learn-present-stage"
          onTouchStart={(e) => { touchStartX.current = e.touches[0].clientX; }}
          onTouchEnd={(e) => {
            if (touchStartX.current == null) return;
            const dx = e.changedTouches[0].clientX - touchStartX.current;
            if (dx > 50) prev();
            else if (dx < -50) next();
            touchStartX.current = null;
          }}
        >
          {screens[index]}
        </div>
        <div className="learn-present-controls">
          <button onClick={prev} disabled={index === 0} aria-label="Sebelumnya">←</button>
          <span className="learn-present-progress">{index + 1} / {SCREEN_COUNT}</span>
          <button onClick={next} disabled={index === SCREEN_COUNT - 1} aria-label="Berikutnya">→</button>
          <button className="learn-present-exit" onClick={() => setPresentMode(false)}>Keluar mode presentasi (Esc)</button>
        </div>
      </div>
    );
  }

  return (
    <div className="learn-page">
      <div className="learn-toolbar">
        <div className="learn-toolbar-title">Belajar: Cara Kerja Agentic Chat</div>
        <button className="learn-present-toggle" onClick={() => setPresentMode(true)}>🎬 Mode presentasi</button>
      </div>
      <nav className="learn-nav">
        {LEVELS.map((l, i) => (
          <a key={l.id} href={`#learn-level-${l.id}`}>{typeof l.index === "number" ? l.index : l.index}</a>
        ))}
        <a href="#learn-level-penutup">∎</a>
      </nav>
      <div className="learn-scroll">{screens}</div>
    </div>
  );
}
