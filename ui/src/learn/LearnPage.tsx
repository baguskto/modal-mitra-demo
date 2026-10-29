import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DemoLink } from "./types";
import { LEVELS } from "./levels";
import { getPresenterQa, type PresenterQaEntry } from "./qa";
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
  qa,
  onDemoLink,
}: {
  level: (typeof LEVELS)[number];
  presenter: boolean;
  qa?: PresenterQaEntry;
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
      {presenter && qa && (
        <div className="learn-qa">
          <div className="learn-qa-lock">🔒 Khusus Presenter — pertanyaan interview</div>
          <p className="learn-qa-q">Q: {qa.interviewQ}</p>
          <p className="learn-qa-a">A: {qa.interviewA}</p>
        </div>
      )}
    </article>
  );
}

function ClosingMap({ presenter, qa }: { presenter: boolean; qa?: PresenterQaEntry }) {
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
      {presenter && qa && (
        <div className="learn-qa">
          <div className="learn-qa-lock">🔒 Khusus Presenter</div>
          <p className="learn-qa-a">{qa.interviewA}</p>
        </div>
      )}
    </article>
  );
}

export default function LearnPage({ presenter, onDemoLink }: LearnPageProps) {
  const [presentMode, setPresentMode] = useState(false);
  const [index, setIndex] = useState(0);
  const [qaById, setQaById] = useState<Record<string, PresenterQaEntry>>({});
  const touchStartX = useRef<number | null>(null);

  // Presenter-only Q&A (lihat ui/src/learn/qa.ts) -- diambil dari server HANYA saat presenter
  // aktif, tidak pernah ikut bundle JS publik.
  useEffect(() => {
    if (!presenter) {
      setQaById({});
      return;
    }
    getPresenterQa().then((list) => setQaById(Object.fromEntries(list.map((q) => [q.id, q]))));
  }, [presenter]);

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
      ...LEVELS.map((l) => <LevelCard key={l.id} level={l} presenter={presenter} qa={qaById[l.id]} onDemoLink={onDemoLink} />),
      <ClosingMap key="penutup" presenter={presenter} qa={qaById["penutup"]} />,
    ],
    [presenter, qaById, onDemoLink],
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
