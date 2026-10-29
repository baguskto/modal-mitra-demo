// Q&A interview /learn — PRESENTER-ONLY, diambil dari server (src/data/presenterQa.ts) HANYA
// kalau mode Presenter aktif (cookie HttpOnly, dicek server di /api/presenter/qa) -> tidak pernah
// ikut bundle JS publik (lihat ui/src/learn/types.ts).
export interface PresenterQaEntry {
  id: string;
  interviewQ: string;
  interviewA: string;
}

export async function getPresenterQa(): Promise<PresenterQaEntry[]> {
  try {
    const res = await fetch("/api/presenter/qa");
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}
