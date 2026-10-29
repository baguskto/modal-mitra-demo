// FIX P0 (freeze/"tombol error"): token ini DULU diminta via window.prompt() dan harus = secret
// CS_TOKEN asli yang pengunjung publik tidak mungkin tahu -> dialog blocking berulang + semua
// panggilan API 401. Sekarang token demo publik ini SENGAJA tidak rahasia (lihat src/index.ts
// PUBLIC_DEMO_CS_TOKEN) — cukup untuk akses BACA konsol CS tanpa prompt sama sekali. Aksi yang
// mengubah data tetap ditolak server (403) kecuali mode Presenter (cookie, otomatis terkirim
// same-origin) atau CS_TOKEN asli — lihat requireFullCs di server.
function getCsToken(): string {
  return "demo-mitra-cs-2026";
}

function csHeaders(): HeadersInit {
  return { "x-cs-token": getCsToken() };
}

/** Gagal (misal DO/D1 belum siap) -> array kosong, bukan crash .map di UI. */
async function csGetList(url: string): Promise<any[]> {
  const res = await fetch(url, { headers: csHeaders() });
  if (!res.ok) return [];
  return res.json();
}

// `mine` = sessionId chat milik browser ini sendiri (sessionStorage, lihat App.tsx) -- server
// memakainya untuk membatasi pengunjung publik (!csFull) HANYA melihat sesinya sendiri, bukan
// "Semua sesi"/antrean milik pengunjung lain (temuan QA #4, ditegakkan di server, src/index.ts).
export async function listSessions(mine?: string) {
  return csGetList(`/api/cs/sessions${mine ? `?mine=${encodeURIComponent(mine)}` : ""}`);
}

export async function listQueue(mine?: string) {
  return csGetList(`/api/cs/queue${mine ? `?mine=${encodeURIComponent(mine)}` : ""}`);
}

export async function getKpi() {
  const res = await fetch(`/api/kpi`);
  return res.json();
}

export async function verifyAudit(sessionId: string, mine?: string) {
  const res = await fetch(`/api/audit/${encodeURIComponent(sessionId)}/verify${mine ? `?mine=${encodeURIComponent(mine)}` : ""}`, { headers: csHeaders() });
  return res.json();
}

export async function getAuditLog(sessionId: string, mine?: string) {
  const res = await fetch(`/api/audit/${encodeURIComponent(sessionId)}/log${mine ? `?mine=${encodeURIComponent(mine)}` : ""}`, { headers: csHeaders() });
  return res.json();
}

// HITL four-eyes (integritas data §Security) — restrukturisasi/keringanan menunggu persetujuan CS.
export async function listHitlPending() {
  return csGetList(`/api/cs/hitl/pending`);
}
// `approver`: nama/identitas approver -- server menolak (409) kalau approver kedua = approver
// pertama (fix "four-eyes palsu", lihat src/index.ts).
export async function approveHitl(restruId: string, approver: string) {
  const res = await fetch(`/api/cs/hitl/${encodeURIComponent(restruId)}/approve`, {
    method: "POST",
    headers: { ...csHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ approver }),
  });
  return res.json();
}
export async function rejectHitl(restruId: string, note?: string) {
  const res = await fetch(`/api/cs/hitl/${encodeURIComponent(restruId)}/reject`, { method: "POST", headers: { ...csHeaders(), "content-type": "application/json" }, body: JSON.stringify({ note }) });
  return res.json();
}

// Panel admin (Presenter-only di UI — tombol ini hanya dirender saat `presenter === true`, lihat
// CsConsole.tsx). FIX P0: dulu minta x-admin-key via prompt() juga; sekarang server menerima cookie
// Presenter (dikirim otomatis, same-origin) sebagai pengganti — tidak perlu prompt/secret kedua.
export async function listKillSwitches() {
  const res = await fetch(`/api/admin/kill-switch`);
  if (!res.ok) return [];
  return res.json();
}
export async function tamperDemo(sessionId: string) {
  const res = await fetch(`/api/admin/tamper-demo/${encodeURIComponent(sessionId)}`, { method: "POST" });
  return res.json();
}
export async function setKillSwitch(toolName: string, disabled: boolean) {
  const res = await fetch(`/api/admin/kill-switch/${encodeURIComponent(toolName)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ disabled, reason: disabled ? "demo kill-switch" : undefined }),
  });
  return res.json();
}

function wsBaseUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}`;
}

/** Koneksi WebSocket real-time untuk pengguna (mitra/pendana) ke sebuah sesi chat — tanpa auth, ini permukaan publik. */
export function connectChatSocket(sessionId: string): WebSocket {
  return new WebSocket(`${wsBaseUrl()}/api/chat/${encodeURIComponent(sessionId)}/ws`);
}

/**
 * Koneksi WebSocket real-time untuk konsol CS (observer + takeover). Browser tidak bisa mengirim
 * header kustom saat handshake WebSocket, jadi token demo dilewatkan sebagai query param (sama-sama
 * diperiksa di server, lihat src/index.ts) — bukan pola produksi, cukup untuk demo internal.
 */
export function connectCsSocket(sessionId: string): WebSocket {
  return new WebSocket(`${wsBaseUrl()}/api/cs/${encodeURIComponent(sessionId)}/ws?token=${encodeURIComponent(getCsToken())}`);
}
