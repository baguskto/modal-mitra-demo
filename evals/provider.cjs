// Provider promptfoo kustom: memanggil worker Modal Mitra Contoh yang sudah dideploy per test case,
// masing-masing dengan sessionId unik (dari vars) agar state DO (verifikasi, mode) tidak bocor
// antar test case. Output dikembalikan sebagai JSON string agar assertion javascript/contains
// bisa memeriksa field reply/citations/toolCallsMade/blockedByGuard/mode/timing sekaligus.
const BASE_URL = process.env.MMK_BASE_URL || "https://modal-mitra-demo.markas-auracheck.workers.dev";
// Setiap invokasi `promptfoo eval` dapat suffix unik -> state Durable Object (mode, verifikasi,
// failedUnderstandingCount) tidak bocor antar RUN eval, walau tetap stabil dalam satu run yang sama.
const RUN_SUFFIX = Date.now().toString(36);

class ModalMitraWorkerProvider {
  constructor(options) {
    this.options = options || {};
  }

  id() {
    return "modal-mitra-worker-http";
  }

  async callApi(prompt, context) {
    const baseSessionId = (context?.vars?.sessionId) || `eval-${Math.random().toString(36).slice(2, 10)}`;
    const sessionId = `${baseSessionId}-${RUN_SUFFIX}`;
    const persona = context?.vars?.persona || "mitra";
    try {
      const res = await fetch(`${BASE_URL}/api/chat/${encodeURIComponent(sessionId)}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: prompt, persona }),
      });
      const data = await res.json();
      return { output: JSON.stringify(data) };
    } catch (err) {
      return { error: String(err) };
    }
  }
}

module.exports = ModalMitraWorkerProvider;
