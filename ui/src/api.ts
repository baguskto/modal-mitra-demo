// Konsol CS & audit log TERLINDUNGI token demo sederhana (lihat README §Keputusan Desain —
// bukan auth produksi, hanya shared-secret agar endpoint internal tidak terbuka tanpa apa pun
// seperti pada basis SIGAP Nasabah). Token diminta sekali via prompt(), disimpan di sessionStorage.
function getCsToken(): string {
  let token = sessionStorage.getItem("mmk_cs_token");
  if (!token) {
    token = window.prompt("Token akses Konsol CS (demo):") ?? "";
    sessionStorage.setItem("mmk_cs_token", token);
  }
  return token;
}

function csHeaders(): HeadersInit {
  return { "x-cs-token": getCsToken() };
}

/** Token salah/kosong -> hapus biar lain kali diminta ulang, dan kembalikan array kosong (bukan crash .map di UI). */
async function csGetList(url: string): Promise<any[]> {
  const res = await fetch(url, { headers: csHeaders() });
  if (!res.ok) {
    sessionStorage.removeItem("mmk_cs_token");
    return [];
  }
  return res.json();
}

export async function listSessions() {
  return csGetList(`/api/cs/sessions`);
}

export async function listQueue() {
  return csGetList(`/api/cs/queue`);
}

export async function getKpi() {
  const res = await fetch(`/api/kpi`);
  return res.json();
}

export async function verifyAudit(sessionId: string) {
  const res = await fetch(`/api/audit/${encodeURIComponent(sessionId)}/verify`, { headers: csHeaders() });
  return res.json();
}

export async function getAuditLog(sessionId: string) {
  const res = await fetch(`/api/audit/${encodeURIComponent(sessionId)}/log`, { headers: csHeaders() });
  return res.json();
}

// HITL four-eyes (integritas data §Security) — restrukturisasi/keringanan menunggu persetujuan CS.
export async function listHitlPending() {
  return csGetList(`/api/cs/hitl/pending`);
}
export async function approveHitl(restruId: string) {
  const res = await fetch(`/api/cs/hitl/${encodeURIComponent(restruId)}/approve`, { method: "POST", headers: csHeaders() });
  return res.json();
}
export async function rejectHitl(restruId: string, note?: string) {
  const res = await fetch(`/api/cs/hitl/${encodeURIComponent(restruId)}/reject`, { method: "POST", headers: { ...csHeaders(), "content-type": "application/json" }, body: JSON.stringify({ note }) });
  return res.json();
}

// Panel admin (Presenter-only di UI) — kill-switch per tool. Admin key terpisah dari CS_TOKEN.
function getAdminKey(): string {
  let key = sessionStorage.getItem("mmk_admin_key");
  if (!key) {
    key = window.prompt("Admin key (panel Presenter):") ?? "";
    sessionStorage.setItem("mmk_admin_key", key);
  }
  return key;
}
export async function listKillSwitches() {
  const res = await fetch(`/api/admin/kill-switch`, { headers: { "x-admin-key": getAdminKey() } });
  if (!res.ok) { sessionStorage.removeItem("mmk_admin_key"); return []; }
  return res.json();
}
export async function tamperDemo(sessionId: string) {
  const res = await fetch(`/api/admin/tamper-demo/${encodeURIComponent(sessionId)}`, { method: "POST", headers: { "x-admin-key": getAdminKey() } });
  return res.json();
}
export async function setKillSwitch(toolName: string, disabled: boolean) {
  const res = await fetch(`/api/admin/kill-switch/${encodeURIComponent(toolName)}`, {
    method: "POST",
    headers: { "x-admin-key": getAdminKey(), "content-type": "application/json" },
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
