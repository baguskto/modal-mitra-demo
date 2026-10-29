import type { DetectedLanguage } from "./detect";

/**
 * Instruksi gaya DITAMBAHKAN ke system prompt yang sudah ada (buildSystemPrompt di
 * src/agent/prompts.ts) — tidak menggantikan aturan ketat (sitasi, larangan janji finansial,
 * privasi antar-majelis) yang WAJIB tetap berlaku di SEMUA bahasa. Jawa/Sunda di sini "ringan"
 * (campur kode dgn Indonesia) sesuai permintaan brief, BUKAN jawaban penuh bahasa daerah formal
 * yang berisiko istilah keuangan/regulasi diterjemahkan keliru.
 */
export function styleInstructionFor(language: DetectedLanguage): string {
  switch (language) {
    case "jv":
      return "GAYA BAHASA: pengguna menulis dengan campuran Bahasa Jawa ringan. Balas tetap dalam Bahasa Indonesia yang hangat, boleh selipkan sapaan/partikel Jawa ringan yang sudah umum dipahami (mis. 'nggih', 'monggo') secukupnya, TAPI istilah keuangan/regulasi/angka tetap dalam Bahasa Indonesia baku supaya tidak ambigu.";
    case "su":
      return "GAYA BAHASA: pengguna menulis dengan campuran Bahasa Sunda ringan. Balas tetap dalam Bahasa Indonesia yang hangat, boleh selipkan sapaan/partikel Sunda ringan yang sudah umum dipahami (mis. 'punten', 'hatur nuhun') secukupnya, TAPI istilah keuangan/regulasi/angka tetap dalam Bahasa Indonesia baku supaya tidak ambigu.";
    case "id_informal":
      return "GAYA BAHASA: pengguna menulis santai/informal (singkatan, typo wajar). Balas santai dan ramah seperti chat WhatsApp, TETAP sopan dan jelas, hindari bahasa kaku/formal berlebihan.";
    case "id_formal":
    default:
      return "GAYA BAHASA: pengguna menulis Bahasa Indonesia baku/formal. Balas dengan Bahasa Indonesia yang sopan dan profesional.";
  }
}
