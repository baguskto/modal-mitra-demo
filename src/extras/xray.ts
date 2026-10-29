// Event X-Ray untuk modul extras — dibuat SESUAI NAMA yang diminta brief ("event X-Ray: 'stt'",
// 'cache_hit', 'route') supaya kompatibel saat worker inti menggabungkan ke skema XrayEvent
// miliknya (src/obs/langfuse.ts, belum committed saat worktree ini dibuat). Bentuk sengaja
// MINIMAL & field-terbatas (tanpa teks mentah/PII) agar aman untuk mode Publik by design, bukan
// di-mask belakangan — selaras §3 plan (visibility-rules.md).

export type ExtrasXrayType =
  | "stt"
  | "tts"
  | "lang_detect"
  | "cache_hit"
  | "cache_miss"
  | "route"
  | "sla_timer"
  | "sla_escalated"
  | "memory_read"
  | "memory_write"
  | "memory_deleted"
  | "prompt_fetch"
  | "online_eval";

export interface ExtrasXrayEvent {
  type: ExtrasXrayType;
  at: string; // ISO timestamp
  sessionId?: string;
  data: Record<string, string | number | boolean | null>;
}

export function xrayEvent(
  type: ExtrasXrayType,
  data: Record<string, string | number | boolean | null>,
  sessionId?: string,
): ExtrasXrayEvent {
  return { type, at: new Date().toISOString(), sessionId, data };
}
