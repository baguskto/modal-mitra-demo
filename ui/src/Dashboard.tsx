import { useEffect, useState } from "react";
import { getKpi } from "./api";

export default function Dashboard() {
  const [kpi, setKpi] = useState<any>(null);

  useEffect(() => {
    getKpi().then(setKpi);
    const t = setInterval(() => getKpi().then(setKpi), 5000);
    return () => clearInterval(t);
  }, []);

  if (!kpi) return <div className="dashboard">Memuat...</div>;

  const ticketsByStatus = Object.fromEntries((kpi.tickets ?? []).map((t: any) => [t.status, t.n]));
  const sessionsByMode = Object.fromEntries((kpi.sessions_by_mode ?? []).map((s: any) => [s.mode, s.n]));
  const sessionsByPersona = Object.fromEntries((kpi.sessions_by_persona ?? []).map((s: any) => [s.persona, s.n]));
  const containmentRate = sessionsByMode.AI && (sessionsByMode.AI + (sessionsByMode.HUMAN ?? 0)) > 0
    ? Math.round((sessionsByMode.AI / (sessionsByMode.AI + (sessionsByMode.HUMAN ?? 0))) * 100)
    : 0;

  return (
    <div className="dashboard">
      <h2>Dashboard Operasional (Demo)</h2>
      <p className="hint">Angka di bawah adalah hasil interaksi langsung di demo ini (data sintetis), bukan angka produksi.</p>
      <div className="kpi-grid">
        <div className="kpi-card"><div className="num">{kpi.sessions_total}</div><div className="label">Total sesi tercatat (audit log)</div></div>
        <div className="kpi-card"><div className="num">{containmentRate}%</div><div className="label">Containment rate (AI tanpa handoff)</div></div>
        <div className="kpi-card"><div className="num">{sessionsByMode.HUMAN ?? 0}</div><div className="label">Sesi dialihkan ke CS (handoff)</div></div>
        <div className="kpi-card"><div className="num">{ticketsByStatus.open ?? 0}</div><div className="label">Tiket pengaduan terbuka</div></div>
        <div className="kpi-card"><div className="num">{kpi.dsr_total}</div><div className="label">Permintaan hak data (DSR)</div></div>
        <div className="kpi-card"><div className="num">{sessionsByPersona.mitra ?? 0} / {sessionsByPersona.pendana ?? 0}</div><div className="label">Sesi mitra / pendana</div></div>
      </div>
      <p className="hint" style={{ marginTop: 16 }}>
        Latensi first-token & total, dan hasil golden set eval bahasa informal/injeksi/privasi antar-majelis ada di README §Eval (dijalankan terpisah via promptfoo + script latensi, lihat evals/).
      </p>
    </div>
  );
}
