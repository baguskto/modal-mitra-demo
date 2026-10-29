import { useRef, useState } from "react";

/**
 * Komponen mandiri (tanpa dependensi ke ChatPanel) — worker inti cukup:
 *   import { VoiceRecorderButton } from "./extras/VoiceRecorder";
 *   <VoiceRecorderButton onTranscribed={(text) => sendMessage(text)} />
 * di dalam toolbar input chat yang sudah ada. Tidak menyentuh state ChatPanel sama sekali.
 */
export function VoiceRecorderButton(props: { onTranscribed: (text: string) => void; apiBase?: string }) {
  const { onTranscribed, apiBase = "/api/extras" } = props;
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  async function start() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => chunksRef.current.push(e.data);
      recorder.onstop = () => void handleStop(stream);
      recorder.start();
      mediaRecorderRef.current = recorder;
      setRecording(true);
    } catch (err: any) {
      setError("Tidak bisa akses mikrofon: " + (err?.message ?? "unknown"));
    }
  }

  function stop() {
    mediaRecorderRef.current?.stop();
    setRecording(false);
  }

  async function handleStop(stream: MediaStream) {
    stream.getTracks().forEach((t) => t.stop());
    setBusy(true);
    try {
      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
      const res = await fetch(`${apiBase}/voice/transcribe`, {
        method: "POST",
        headers: { "content-type": "audio/webm" },
        body: blob,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `http_${res.status}`);
      }
      const data = await res.json();
      if (data.text) onTranscribed(data.text);
      else setError("Tidak ada teks terdeteksi, coba ulang.");
    } catch (err: any) {
      setError("Gagal transkripsi: " + (err?.message ?? "unknown"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="voice-recorder">
      <button
        type="button"
        onClick={recording ? stop : start}
        disabled={busy}
        aria-pressed={recording}
        title={recording ? "Berhenti merekam" : "Rekam voice note"}
      >
        {busy ? "⏳" : recording ? "⏹ Berhenti" : "🎤 Voice note"}
      </button>
      {error && <span className="voice-recorder-error">{error}</span>}
    </div>
  );
}

/**
 * Balasan suara: coba endpoint TTS Workers AI; bila `available:false` (model TTS Indonesia belum
 * tersedia), jatuh ke Web Speech API browser (`speechSynthesis`, lang id-ID) — selalu ada fallback,
 * tidak pernah gagal total.
 */
export async function speakReply(text: string, apiBase = "/api/extras"): Promise<void> {
  try {
    const res = await fetch(`${apiBase}/voice/speak`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (data.available && data.audioBase64) {
      const audio = new Audio(`data:${data.contentType ?? "audio/mpeg"};base64,${data.audioBase64}`);
      await audio.play();
      return;
    }
  } catch {
    // lanjut ke fallback browser di bawah
  }
  if ("speechSynthesis" in window) {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "id-ID";
    window.speechSynthesis.speak(utterance);
  }
}
