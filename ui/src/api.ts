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
