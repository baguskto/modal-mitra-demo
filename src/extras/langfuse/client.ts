// Bentuk konfigurasi SENGAJA identik dengan `LangfuseConfig` di src/obs/langfuse.ts (klien trace
// milik worker inti, belum committed saat worktree ini dibuat) — supaya saat digabung, satu objek
// config bisa dipakai untuk trace DAN prompt management/online eval tanpa penyesuaian.
export interface LangfuseConfig {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
}

export function basicAuthHeader(cfg: LangfuseConfig): string {
  const token = btoa(`${cfg.publicKey}:${cfg.secretKey}`);
  return `Basic ${token}`;
}

export function isLangfuseConfigured(cfg: Partial<LangfuseConfig> | undefined | null): cfg is LangfuseConfig {
  return Boolean(cfg?.baseUrl && cfg?.publicKey && cfg?.secretKey);
}
