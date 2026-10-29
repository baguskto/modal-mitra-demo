// Mode Publik vs Presenter (lihat visibility-rules.md) — status dibaca dari cookie HttpOnly via
// endpoint, TIDAK disimpan di localStorage/JS (cookie yang menentukan, ini hanya cache tampilan).
export async function getPresenterStatus(): Promise<boolean> {
  try {
    const res = await fetch("/api/presenter/status");
    const data = await res.json();
    return !!data.presenter;
  } catch {
    return false;
  }
}

export async function presenterLogin(key: string): Promise<boolean> {
  const res = await fetch("/api/presenter/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
  return res.ok;
}

export async function presenterLogout(): Promise<void> {
  await fetch("/api/presenter/logout", { method: "POST" });
}
