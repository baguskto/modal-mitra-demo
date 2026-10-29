// Mode Publik vs Presenter (lihat projects/interview-prep/visibility-rules.md — WAJIB).
// Cookie HttpOnly berumur pendek, nilainya token BERTANDA (signed), BUKAN passphrase mentah:
// `${expiryEpochMs}.${hmacHex}` dengan hmac = HMAC-SHA256(PRESENTER_KEY, `presenter:${expiry}`).
// Ini menghindari menyimpan/mengirim ulang PRESENTER_KEY mentah di cookie (kalau cookie dicuri,
// penyerang dapat sesi presenter sampai expiry, TIDAK dapat passphrase itu sendiri untuk login
// ulang kapan saja).
const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 jam — cukup untuk 1 sesi interview/demo
const COOKIE_NAME = "mmk_presenter";

async function hmacHex(key: string, input: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(input));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signPresenterToken(presenterKey: string): Promise<string> {
  const expiry = Date.now() + SESSION_TTL_MS;
  const mac = await hmacHex(presenterKey, `presenter:${expiry}`);
  return `${expiry}.${mac}`;
}

export async function verifyPresenterToken(presenterKey: string | undefined, token: string | undefined): Promise<boolean> {
  if (!presenterKey || !token) return false;
  const [expiryStr, mac] = token.split(".");
  const expiry = Number(expiryStr);
  if (!expiry || Date.now() > expiry) return false;
  const expected = await hmacHex(presenterKey, `presenter:${expiry}`);
  return expected === mac;
}

export function readCookie(cookieHeader: string | null | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export function presenterCookieName(): string {
  return COOKIE_NAME;
}

export function presenterCookieHeader(token: string, secure: boolean): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function clearPresenterCookieHeader(secure: boolean): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}
