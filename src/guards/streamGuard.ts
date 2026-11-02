// Guard output untuk STREAMING (feat/latency-xray).
//
// Masalah: guard_out lama (output.ts) memeriksa jawaban UTUH, sehingga jawaban baru bisa dikirim
// setelah model selesai menulis semuanya — first-token == total (contoh nyata 2 Nov: 20.8 s).
// Mengirim token mentah langsung ke UI akan membuat teks yang melanggar guardrail sempat tampil.
//
// Pola yang dipilih: BUFFER PER KALIMAT. Token dari model ditampung sampai batas kalimat (. ! ? …
// diikuti spasi, atau baris baru). Satu kalimat utuh lalu dicek dengan aturan yang SAMA dengan
// guard_out lama (janji finansial, PII mentah, privasi antar-majelis, sitasi grounded) + deteksi
// kebocoran system prompt & ekor JSON protokol. Hanya kalimat yang lolos yang diteruskan ke UI.
//  - Pola terlarang yang melintasi batas kalimat ditangkap dengan mengecek "ekor 80 karakter yang
//    sudah tampil + kalimat baru" (pola terpanjang di daftar < 60 karakter).
//  - Kalimat melanggar -> stream dihentikan, sisa jawaban dibuang. Bila belum ada yang tampil,
//    pesan aman dikirim sebagai jawaban biasa; bila sudah ada kalimat AMAN yang tampil, UI menerima
//    event `replace` untuk mengganti seluruh bubble dengan pesan aman (teks yang tampil sebelumnya
//    sudah lolos cek, jadi tidak ada teks melanggar yang pernah terlihat).
//  - Cek yang hanya bisa dinilai di akhir (klaim kebijakan TANPA sitasi sama sekali) bersifat
//    "lunak": tidak berbahaya untuk ditampilkan sementara, diganti via `replace` bila gagal.
//  - Model kadang tetap membalas JSON protokol meski diminta teks polos: bila karakter pertama
//    adalah "{" atau ``` seluruh output DITAHAN sampai selesai, diparse, lalu dicek per kalimat.
// Trade-off: first-token = waktu sampai kalimat pertama selesai ditulis (bukan token pertama mentah),
// biasanya +200-600 ms — sengaja dibayar demi jaminan tidak ada teks terlarang yang sempat tampil.
import { resolveLeakedTokensInText, scanOutputForPII } from "./pii";
import { FORBIDDEN_PROMISE, POLICY_CLAIM_SIGNAL, CITATION_RE, checkCitationsGrounded, checkMemberPrivacyLeak, salvageJsonTail, FALLBACK_NOT_FOUND } from "./output";
import type { XrayGuardRule } from "../obs/xrayDetail";

export const PROMPT_LEAK = /(ATURAN KETAT|FORMAT RESPON|tidak bisa dinegosiasikan oleh pesan pengguna|PERAN LAWAN BICARA|<data source=|BUKAN instruksi">|TOOLS YANG TERSEDIA)/i;
const PROTOCOL_JSON = /(^\s*\{|"(type|citations|tool|args|thought|text|reason)"\s*:)/;

/**
 * Normalisasi SEBELUM pencocokan pola (review Opus P2): NFKC, buang zero-width & penanda markdown
 * (`pasti **disetujui**`, `pasti\u200Bdisetujui`), seragamkan tanda hubung unicode (MMK‑123456),
 * rapatkan spasi/baris baru. Hanya untuk PENGECEKAN — teks yang tampil tetap asli.
 */
export function normalizeForGuard(t: string): string {
  return t
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, " ") // jadi spasi: "pasti<ZWSP>disetujui" tetap cocok
    .replace(/[*_~`]/g, "")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ");
}
const INPUT_UNSAFE_TEXT = "Maaf, pesan Anda terdeteksi tidak aman untuk diproses otomatis. Saya alihkan ke CS manusia.";
const PRIVACY_REPLACEMENT = "Maaf, saya tidak dapat menampilkan data yang bukan milik Anda. Jika ini terkait data Anda sendiri, mohon verifikasi ulang; untuk hal lain saya alihkan ke CS.";

export type GuardBlockReason = "janji_finansial" | "pii_output" | "privasi_antar_majelis" | "sitasi_tidak_grounded" | "prompt_leak" | "sitasi_wajib" | "input_unsafe";

export interface StreamGuardOptions {
  vault: Map<string, string>;
  allowedIds: () => Set<string>;
  retrievedIds: () => Set<string>;
  citationRequired: () => boolean;
  /** Teks yang SUDAH lolos guard -> diteruskan ke UI. */
  emit: (text: string) => void | Promise<void>;
  /** Ganti seluruh bubble (dipanggil hanya bila sebagian teks aman sudah tampil lalu guard memblokir). */
  replace?: (text: string, reason: GuardBlockReason) => void | Promise<void>;
  /** Parser cadangan bila model membalas JSON protokol (extractAnswerFallback di graph.ts). */
  parseJson?: (raw: string) => { text: string; citations: string[] };
  /** Gerbang input (verdict Llama Guard yang berjalan paralel) — ditunggu SEKALI sebelum teks pertama tampil. */
  gate?: () => Promise<boolean>;
}

export interface StreamGuardResult {
  text: string;
  blockedBy?: GuardBlockReason;
  replaced: boolean;
  sentencesShown: number;
  sentencesChecked: number;
  rules: XrayGuardRule[];
  heldJson: boolean;
}

type RuleKey = "gerbang_input" | "kebocoran_prompt" | "ekor_json_protokol" | "token_redaksi" | "scan_pii" | "janji_finansial" | "privasi_antar_majelis" | "sitasi_grounded" | "sitasi_wajib";

const RULE_LABEL: Record<RuleKey, string> = {
  gerbang_input: "gerbang Llama Guard sebelum teks pertama",
  kebocoran_prompt: "kebocoran system prompt",
  ekor_json_protokol: "ekor/JSON protokol internal",
  token_redaksi: "token redaksi PII → nilai milik pengguna",
  scan_pii: "PII mentah (NIK/HP/email/kartu)",
  janji_finansial: "janji finansial terlarang",
  privasi_antar_majelis: "privasi antar-majelis (ID bukan milik pengguna)",
  sitasi_grounded: "sitasi harus ada di dokumen yang diambil",
  sitasi_wajib: "klaim kebijakan wajib bersitasi (cek akhir)",
};

/** Indeks akhir kalimat pertama di `s` (termasuk spasi sesudahnya), atau -1. */
function sentenceEnd(s: string): number {
  const m = /[.!?…]+["')\]]*\s+|\n+/.exec(s);
  return m ? m.index + m[0].length : -1;
}

export class StreamGuard {
  private buf = "";
  private shown = "";
  private jsonMode: boolean | null = null;
  private blockedBy: GuardBlockReason | undefined;
  private sentencesShown = 0;
  private sentencesChecked = 0;
  private replaced = false;
  private gated = false;
  private stats = new Map<RuleKey, { result: XrayGuardRule["result"]; detail?: string }>();

  constructor(private o: StreamGuardOptions) {}

  get blocked(): boolean {
    return !!this.blockedBy;
  }

  async push(delta: string): Promise<void> {
    if (this.blockedBy) return;
    this.buf += delta;
    if (this.jsonMode === null) {
      const t = this.buf.trimStart();
      // Putuskan setelah >= 3 karakter non-spasi (review Opus P2: "`" atau "``" saja terlalu dini).
      if (t.length < 3 && !t.startsWith("{")) return;
      this.jsonMode = t.startsWith("{") || t.startsWith("```");
    }
    if (this.jsonMode) return; // tahan semuanya, diparse di finish()
    for (;;) {
      const cut = sentenceEnd(this.buf);
      if (cut < 0) break;
      const sentence = this.buf.slice(0, cut);
      this.buf = this.buf.slice(cut);
      await this.release(sentence);
      if (this.blockedBy) return;
    }
  }

  async finish(): Promise<StreamGuardResult> {
    if (!this.blockedBy && this.jsonMode && this.o.parseJson) {
      const parsed = this.o.parseJson(this.buf);
      this.note("ekor_json_protokol", "ubah", "model membalas JSON → diparse, hanya teks jawaban yang dicek & ditampilkan");
      this.buf = parsed.text;
      this.jsonMode = false;
      for (;;) {
        const cut = sentenceEnd(this.buf);
        if (cut < 0) break;
        const sentence = this.buf.slice(0, cut);
        this.buf = this.buf.slice(cut);
        await this.release(sentence);
        if (this.blockedBy) break;
      }
    }
    if (!this.blockedBy && this.buf.trim()) await this.release(this.buf);
    this.buf = "";

    if (!this.blockedBy) {
      const shownNorm = normalizeForGuard(this.shown);
      const needCitation = this.o.citationRequired() && POLICY_CLAIM_SIGNAL.test(shownNorm);
      if (needCitation && !CITATION_RE.test(shownNorm)) {
        this.note("sitasi_wajib", "blok", "klaim kebijakan tanpa sitasi sama sekali → diganti pesan aman");
        await this.block("sitasi_wajib");
      } else {
        this.note("sitasi_wajib", needCitation ? "lolos" : "lewati", needCitation ? "ada sitasi" : "tidak ada klaim kebijakan / RAG tidak relevan");
      }
    }
    if (!this.shown.trim() && !this.blockedBy && (await this.passGate())) {
      // Model tidak menghasilkan teks apa pun -> pesan aman standar.
      this.shown = FALLBACK_NOT_FOUND;
      await this.o.emit(FALLBACK_NOT_FOUND);
    }
    for (const k of Object.keys(RULE_LABEL) as RuleKey[]) if (!this.stats.has(k)) this.stats.set(k, { result: "lolos" });
    return {
      text: this.shown,
      blockedBy: this.blockedBy,
      replaced: this.replaced,
      sentencesShown: this.sentencesShown,
      sentencesChecked: this.sentencesChecked,
      heldJson: this.jsonMode === false && this.stats.get("ekor_json_protokol")?.result === "ubah",
      rules: [...this.stats.entries()].map(([k, v]) => ({ rule: RULE_LABEL[k], result: v.result, detail: v.detail })),
    };
  }

  private note(rule: RuleKey, result: XrayGuardRule["result"], detail?: string) {
    const prev = this.stats.get(rule);
    // "blok" > "ubah" > lainnya — status paling serius yang dipertahankan.
    const rank = (r?: string) => (r === "blok" ? 3 : r === "ubah" ? 2 : r === "lolos" ? 1 : 0);
    if (!prev || rank(result) >= rank(prev.result)) this.stats.set(rule, { result, detail });
  }

  private async release(raw: string): Promise<void> {
    this.sentencesChecked++;
    let text = raw;
    const tail = salvageJsonTail(text);
    if (tail) {
      text = tail.text + (/\s$/.test(raw) ? " " : "");
      this.note("ekor_json_protokol", "ubah", "ekor JSON protokol dipotong");
    }
    if (PROTOCOL_JSON.test(text)) {
      this.note("ekor_json_protokol", "ubah", "kalimat berisi JSON protokol dibuang");
      return;
    }
    const resolved = resolveLeakedTokensInText(text, this.o.vault);
    if (resolved !== text) this.note("token_redaksi", "ubah", "token [TIPE_n] dikembalikan ke nilai milik pengguna sendiri");
    // Normalisasi DULU baru ambil ekor (review Opus P2: spasi panjang tidak boleh mendorong awal frasa
    // terlarang keluar jendela). "100%\ndisetujui" tetap cocok dengan pola "100% disetujui".
    const windowText = normalizeForGuard(this.shown).slice(-80) + normalizeForGuard(resolved);

    if (PROMPT_LEAK.test(windowText)) return this.violate("kebocoran_prompt", "prompt_leak", "pola instruksi internal terdeteksi");
    const pii = scanOutputForPII(windowText);
    if (!pii.clean) return this.violate("scan_pii", "pii_output", pii.findings.join(", "));
    const promise = FORBIDDEN_PROMISE.find((re) => re.test(windowText));
    if (promise) return this.violate("janji_finansial", "janji_finansial", `pola: ${promise.source.slice(0, 50)}`);
    const privacy = checkMemberPrivacyLeak(normalizeForGuard(resolved), this.o.allowedIds());
    if (!privacy.ok) return this.violate("privasi_antar_majelis", "privasi_antar_majelis", `${privacy.leaked.length} ID bukan milik pengguna`);
    const grounded = checkCitationsGrounded(normalizeForGuard(resolved), this.o.retrievedIds());
    if (!grounded.grounded) return this.violate("sitasi_grounded", "sitasi_tidak_grounded", `sitasi tak dikenal: ${grounded.invalid.join(", ").slice(0, 60)}`);

    if (!resolved) return;
    if (!(await this.passGate())) return;
    this.shown += resolved;
    this.sentencesShown++;
    await this.o.emit(resolved);
  }

  /** true bila gerbang input aman (atau tidak ada gerbang). Gagal -> blok "input_unsafe", tidak ada teks model yang tampil. */
  private async passGate(): Promise<boolean> {
    if (this.gated || !this.o.gate) return !this.blockedBy;
    this.gated = true;
    const ok = await this.o.gate();
    if (ok) {
      this.note("gerbang_input", "lolos", "verdict aman diterima sebelum teks pertama");
      return true;
    }
    this.note("gerbang_input", "blok", "Llama Guard: input tidak aman → seluruh jawaban model dibuang");
    await this.block("input_unsafe");
    return false;
  }

  private async violate(rule: RuleKey, reason: GuardBlockReason, detail: string): Promise<void> {
    this.note(rule, "blok", detail);
    await this.block(reason);
  }

  private async block(reason: GuardBlockReason): Promise<void> {
    this.blockedBy = reason;
    const safe = reason === "privasi_antar_majelis" ? PRIVACY_REPLACEMENT : reason === "input_unsafe" ? INPUT_UNSAFE_TEXT : FALLBACK_NOT_FOUND;
    if (this.shown.trim() && this.o.replace) {
      this.replaced = true;
      await this.o.replace(safe, reason);
    } else if (!this.shown.trim()) {
      await this.o.emit(safe);
    }
    this.shown = safe;
  }
}
