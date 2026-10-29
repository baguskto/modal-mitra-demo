import { useEffect, useState, type FormEvent } from "react";
import ChatPanel from "./ChatPanel";
import CsConsole from "./CsConsole";
import Dashboard from "./Dashboard";
import LearnPage from "./learn/LearnPage";
import type { DemoLink } from "./learn/types";
import { getPresenterStatus, presenterLogin, presenterLogout } from "./presenter";

function randomSessionId() {
  return `sess-${Math.random().toString(36).slice(2, 10)}`;
}

type Tab = "chat" | "cs" | "dash" | "learn";

export default function App() {
  const [tab, setTab] = useState<Tab>(() =>
    window.location.pathname.startsWith("/learn") ? "learn" : "chat",
  );
  const [presenter, setPresenter] = useState(false);
  // FIX (temuan QA m6, "window.prompt() dialog blocking"): login Presenter sekarang form inline
  // (non-blocking), bukan window.prompt() -- pola yang sama persis dengan bug freeze P0 sebelumnya.
  const [showPresenterLogin, setShowPresenterLogin] = useState(false);
  const [presenterKeyInput, setPresenterKeyInput] = useState("");
  const [presenterLoginError, setPresenterLoginError] = useState<string | null>(null);
  const [pendingDemo, setPendingDemo] = useState<DemoLink | null>(null);
  const [sessionId] = useState(() => {
    const existing = sessionStorage.getItem("mmk_session_id");
    if (existing) return existing;
    const id = randomSessionId();
    sessionStorage.setItem("mmk_session_id", id);
    return id;
  });

  useEffect(() => {
    getPresenterStatus().then(setPresenter);
  }, []);

  function goToTab(next: Tab) {
    setTab(next);
    const path = next === "learn" ? "/learn" : "/";
    if (window.location.pathname !== path) window.history.pushState(null, "", path);
  }

  function handleDemoLink(demo: DemoLink) {
    setPendingDemo(demo);
    goToTab("chat");
  }

  async function togglePresenter() {
    if (presenter) {
      await presenterLogout();
      setPresenter(false);
      return;
    }
    setPresenterLoginError(null);
    setPresenterKeyInput("");
    setShowPresenterLogin(true);
  }

  async function submitPresenterLogin(e: FormEvent) {
    e.preventDefault();
    if (!presenterKeyInput) return;
    const ok = await presenterLogin(presenterKeyInput);
    if (ok) {
      setPresenter(true);
      setShowPresenterLogin(false);
      setPresenterKeyInput("");
    } else {
      setPresenterLoginError("Passphrase salah.");
    }
  }

  return (
    <div className="app">
      <div className="banner">⚠️ Demo dengan data 100% sintetis — bukan afiliasi lembaga manapun.</div>
      <div className="tabs">
        <button className={tab === "chat" ? "active" : ""} onClick={() => goToTab("chat")}>Live Chat</button>
        <button className={tab === "cs" ? "active" : ""} onClick={() => goToTab("cs")}>Konsol CS</button>
        <button className={tab === "dash" ? "active" : ""} onClick={() => goToTab("dash")}>Dashboard</button>
        <button className={tab === "learn" ? "active" : ""} onClick={() => goToTab("learn")}>Belajar</button>
        <div style={{ marginLeft: "auto", color: "#c9d4e8", fontSize: 12, alignSelf: "center" }}>
          Modal Mitra Contoh · demo · sesi: {sessionId}
          {" "}
          <button className="new-session-btn" onClick={() => { sessionStorage.removeItem("mmk_session_id"); window.location.reload(); }}>sesi baru</button>
          {" "}
          <button className="new-session-btn" style={{ opacity: 0.6 }} onClick={togglePresenter} title="Mode Presenter">
            {presenter ? "🔓 Presenter" : "🔒"}
          </button>
        </div>
      </div>
      {showPresenterLogin && (
        <form className="presenter-login-inline" onSubmit={submitPresenterLogin}>
          <span>Passphrase Presenter:</span>
          <input
            type="password"
            autoFocus
            value={presenterKeyInput}
            onChange={(e) => setPresenterKeyInput(e.target.value)}
          />
          <button type="submit">Masuk</button>
          <button type="button" onClick={() => setShowPresenterLogin(false)}>Batal</button>
          {presenterLoginError && <span className="presenter-login-error">{presenterLoginError}</span>}
        </form>
      )}
      <div className="content">
        {tab === "chat" && (
          <ChatPanel
            sessionId={sessionId}
            presenter={presenter}
            pendingDemo={pendingDemo}
            onDemoConsumed={() => setPendingDemo(null)}
          />
        )}
        {tab === "cs" && <CsConsole presenter={presenter} mySessionId={sessionId} />}
        {tab === "dash" && <Dashboard />}
        {tab === "learn" && <LearnPage presenter={presenter} onDemoLink={handleDemoLink} />}
      </div>
    </div>
  );
}
