import { useEffect, useState } from "react";
import ChatPanel from "./ChatPanel";
import CsConsole from "./CsConsole";
import Dashboard from "./Dashboard";
import { getPresenterStatus, presenterLogin, presenterLogout } from "./presenter";

function randomSessionId() {
  return `sess-${Math.random().toString(36).slice(2, 10)}`;
}

export default function App() {
  const [tab, setTab] = useState<"chat" | "cs" | "dash">("chat");
  const [presenter, setPresenter] = useState(false);
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

  async function togglePresenter() {
    if (presenter) {
      await presenterLogout();
      setPresenter(false);
      return;
    }
    const key = window.prompt("Passphrase Presenter:");
    if (!key) return;
    const ok = await presenterLogin(key);
    if (ok) setPresenter(true);
    else window.alert("Passphrase salah.");
  }

  return (
    <div className="app">
      <div className="banner">⚠️ Demo dengan data 100% sintetis — bukan afiliasi lembaga manapun.</div>
      <div className="tabs">
        <button className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}>Live Chat</button>
        <button className={tab === "cs" ? "active" : ""} onClick={() => setTab("cs")}>Konsol CS</button>
        <button className={tab === "dash" ? "active" : ""} onClick={() => setTab("dash")}>Dashboard</button>
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
      <div className="content">
        {tab === "chat" && <ChatPanel sessionId={sessionId} />}
        {tab === "cs" && <CsConsole presenter={presenter} />}
        {tab === "dash" && <Dashboard />}
      </div>
    </div>
  );
}
