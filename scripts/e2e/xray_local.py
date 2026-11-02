"""Playwright LOKAL (tanpa wrangler): build UI (`vite preview`) + WebSocket Agents SDK di-route oleh
Playwright untuk MEMUTAR ULANG giliran NYATA yang direkam harness (scripts/measure-golden.ts CAPTURE=1
-> scripts/e2e/fixtures/*.json): event X-Ray asli + potongan teks ber-timestamp asli + data-meta.

Yang diverifikasi (390 px & 1440 px):
  1. Teks jawaban muncul BERTAHAP (streaming) — bubble sudah berisi kalimat pertama sebelum giliran selesai.
  2. X-Ray: waterfall + kartu per fase dengan durasi; kartu bisa dibuka (teknik, model/tool, RAG, guard).
  3. Intent telat bayar informal = keterlambatan.
  4. Replace guard: bila fixture punya `replacedWith`, teks terlarang tidak pernah tampil.
  5. 0 console error.
Jalankan: npx vite preview --config ui/vite.config.ts --port 4173 &  lalu
          python3 scripts/e2e/xray_local.py [out_dir]
"""
import json
import pathlib
import sys
import time

from playwright.sync_api import sync_playwright

BASE = "http://localhost:4173"
OUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/xray-shots")
OUT.mkdir(parents=True, exist_ok=True)
FIX = pathlib.Path(__file__).parent / "fixtures"
REPLAY_SPEED = 1.0  # 1.0 = timing asli (ms) dari rekaman


def load(name):
    return json.loads((FIX / f"{name}.json").read_text())


def chunk_frames(fx):
    """Bangun frame UIMessageStream (sama seperti ChatAgent.onChatMessage) dengan jadwal ms asli."""
    frames = [(0, {"type": "start"})]
    text_id = "t1"
    started = False
    for d in fx["deltas"]:
        if not started:
            frames.append((d["atMs"], {"type": "text-start", "id": text_id}))
            started = True
        frames.append((d["atMs"], {"type": "text-delta", "id": text_id, "delta": d["text"]}))
    end_ms = fx["meta"]["timing"]["totalMs"]
    if started:
        frames.append((end_ms, {"type": "text-end", "id": text_id}))
    if fx.get("replacedWith"):
        frames.append((end_ms, {"type": "data-guard", "id": "g1", "data": {"action": "replace", **fx["replacedWith"]}}))
    frames.append((end_ms + 5, {"type": "data-meta", "id": "m1", "data": fx["meta"]}))
    frames.append((end_ms + 6, {"type": "finish"}))
    return frames


def run_case(p, fx_name, width, height, open_cards):
    fx = load(fx_name)
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": width, "height": height})
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))

    # HTTP /api/* yang dipanggil UI saat load (status presenter dll.) -> jawaban minimal valid.
    # (get-messages = riwayat awal useAgentChat -> array kosong)
    def api(route):
        body = [] if "get-messages" in route.request.url else {"presenter": False, "items": [], "sessions": []}
        route.fulfill(status=200, content_type="application/json", body=json.dumps(body))
    page.route("**/api/**", api)

    state = {"ws": None}

    def on_ws(ws):
        state["ws"] = ws

        def on_message(msg):
            try:
                data = json.loads(msg)
            except Exception:
                return
            t = data.get("type")
            if t == "cf_agent_stream_resume_request":
                ws.send(json.dumps({"type": "cf_agent_stream_resume_none"}))
            elif t == "cf_agent_use_chat_request":
                state["req"] = data["id"]

        ws.on_message(on_message)
        ws.send(json.dumps({"type": "init", "history": [], "mode": "AI", "persona": fx["persona"], "verifiedActorId": None, "handoffSummary": None, "handoffAt": None, "slaMinutes": 5}))

    page.route_web_socket("**/api/chat/**", on_ws)
    page.goto(BASE + "/")
    page.wait_for_timeout(800)
    page.get_by_title("X-Ray mode").click()
    if fx["persona"] == "pendana":
        page.get_by_role("button", name="Pendana").click()
    page.fill(".wa-input-row input", fx["userText"])
    page.click(".wa-input-row button:has-text('Kirim')")
    for _ in range(200):
        if state.get("req"):
            break
        page.wait_for_timeout(50)
    req_id = state["req"]
    ws = state["ws"]

    # Jadwal replay: event X-Ray (offset ts asli) + frame stream (atMs asli), dikirim dari alur utama.
    evs = sorted(fx["meta"]["xray"], key=lambda e: e["ts"])
    def ms_of(ts):
        return time.mktime(time.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S")) * 1000 + int(ts[20:23])
    base = ms_of(evs[0]["ts"]) if evs else 0
    schedule = [(ms_of(e["ts"]) - base, "x", {"type": "xray_event", "event": e}) for e in evs]
    for at, frame in chunk_frames(fx):
        schedule.append((at, frame["type"], {"type": "cf_agent_use_chat_response", "id": req_id, "body": json.dumps(frame), "done": False}))
    schedule.sort(key=lambda x: x[0])
    t0 = time.time()
    partial_text = None
    bubble = page.locator(".wa-bubble.ai").last
    for at, kind, payload in schedule:
        wait = at / 1000 / REPLAY_SPEED - (time.time() - t0)
        if wait > 0:
            page.wait_for_timeout(wait * 1000)
        ws.send(json.dumps(payload))
        if kind == "text-delta" and partial_text is None:
            page.wait_for_timeout(120)
            partial_text = bubble.inner_text() if bubble.count() else ""
            first_visible_s = time.time() - t0
    ws.send(json.dumps({"type": "cf_agent_use_chat_response", "id": req_id, "body": "", "done": True}))
    first_delta_ms = fx["deltas"][0]["atMs"] if fx["deltas"] else None
    page.wait_for_selector(".xray-meta", timeout=30000)
    page.wait_for_timeout(400)
    final_text = bubble.inner_text()
    partial_text = partial_text or ""
    streamed_progressively = len(fx["deltas"]) > 1 and 0 < len(partial_text) < len(final_text)

    # (2) Buka kartu fase yang diminta.
    for node in open_cards:
        page.locator(f".xray-node[data-node='{node}'] .xr-card-head").click()
    page.wait_for_timeout(300)
    shot = OUT / f"{fx_name}-{width}.png"
    page.screenshot(path=str(shot), full_page=True)
    panel = page.locator("[data-testid='xray-panel']")
    panel_shot = OUT / f"{fx_name}-{width}-xray.png"
    panel.screenshot(path=str(panel_shot))
    xray_text = panel.inner_text()

    res = {
        "case": fx_name,
        "width": width,
        "firstDeltaRecordedMs": first_delta_ms,
        "firstTextVisibleAtS": round(first_visible_s, 2) if partial_text else None,
        "streamedProgressively": streamed_progressively,
        "partialLen": len(partial_text),
        "finalLen": len(final_text),
        "intentShown": f"intent: {fx['meta']['intent']}" in xray_text,
        "waterfall": page.locator(".xr-wf-row").count(),
        "cards": page.locator(".xray-node").count(),
        "hasTechnique": "teknik" in xray_text.lower(),
        "hasDurations": " ms" in xray_text,
        "noForbiddenShown": not any(s in final_text for s in ["pasti disetujui", "ATURAN KETAT", '"type"']),
        "consoleErrors": errors,
        "screenshots": [str(shot), str(panel_shot)],
    }
    browser.close()
    return res


if __name__ == "__main__":
    results = []
    with sync_playwright() as p:
        for width, height in [(390, 844), (1440, 900)]:
            results.append(run_case(p, "g02_telat_informal", width, height, ["guard_in", "route_intent", "tools", "guard_out"]))
            results.append(run_case(p, "g03_verify_angsuran", width, height, ["verify_identity", "tools"]))
    print(json.dumps(results, indent=1))
    bad = [r for r in results if r["consoleErrors"] or not r["cards"] or not r["intentShown"]]
    sys.exit(1 if bad else 0)
