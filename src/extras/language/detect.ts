// Fitur #2: deteksi bahasa & gaya balasan sesuai bahasa pengguna (Indonesia informal, Jawa,
// Sunda ringan). Sengaja heuristik leksikon + regex (konsisten dgn gaya router.ts/classifyIntent
// di repo ini — deterministik, murah, bisa dites tanpa panggilan LLM) BUKAN model klasifikasi
// bahasa penuh: korpus campur-kode Jawa/Sunda-Indonesia terlalu kecil untuk model statistik
// umum, dan literasi ejaan daerah sangat beragam (lihat README existing: guardrail sudah toleran
// typo/singkatan/bahasa daerah ringan). LLM tidak dipakai di sini supaya deteksi bahasa TIDAK
// menambah 1 panggilan model lagi (biaya/latensi) sebelum giliran utama bahkan dimulai.

export type DetectedLanguage = "id_informal" | "jv" | "su" | "id_formal";

export interface LanguageDetection {
  language: DetectedLanguage;
  confidence: number; // 0..1, heuristik berbasis jumlah kata kunci cocok
  matchedWords: string[];
}

// Leksikon ringkas kata/partikel KHAS (bukan kata yang juga umum di Indonesia formal) supaya
// presisi tinggi walau recall sedang — salah deteksi bahasa daerah untuk pengguna yang sebenarnya
// berbahasa Indonesia formal lebih merugikan (gaya balasan jadi aneh) daripada sesekali tidak
// terdeteksi (tetap jatuh ke id_informal/id_formal yang netral).
const JAVANESE_WORDS = [
  "kulo", "kowe", "piye", "sampun", "mboten", "nggih", "monggo", "matur nuwun", "niki", "niku",
  "sampeyan", "panjenengan", "pripun", "kados", "napa", "ngertos", "ora ngerti", "sinten", "kapan e",
  "wonten", "dereng", "lagi nopo",
];
const SUNDANESE_WORDS = [
  "abdi", "euy", "kumaha", "kedah", "atos", "teu acan", "hatur nuhun", "punten", "naon", "dimana",
  "iraha", "sabaraha", "kunaon", "sakedap", "nuju", "tiasa", "moal", "bade", "tos", "kacida",
];
// Partikel/singkatan khas Indonesia informal (chat/SMS style) — dipakai untuk membedakan
// id_informal vs id_formal (gaya balasan tetap Bahasa Indonesia untuk keduanya, hanya tingkat
// formalitas berbeda, lihat styleInstructionFor).
const INFORMAL_MARKERS = [
  /\bga\b/, /\bgak\b/, /\bgpp\b/, /\bgt\b/, /\bgitu\b/, /\bbgt\b/, /\bbanget\b/, /\bdong\b/, /\bsih\b/,
  /\bkayak\b/, /\bkak\b/, /\bmin\b/, /\bgimana\b/, /\bgmn\b/, /\byg\b/, /\byang\b/, /\btlg\b/, /\bpls\b/,
  /\bmaap\b/, /\bmaaf\b/, /\bkak[.,!?]/, /\bnder\b/, /\bmnt\b/, /\bsy\b/, /\baq\b/, /\baku\b/, /\bkamu\b/,
];

function scoreLexicon(textLower: string, words: string[]): { score: number; matched: string[] } {
  const matched = words.filter((w) => textLower.includes(w));
  return { score: matched.length, matched };
}

export function detectLanguage(text: string): LanguageDetection {
  const lower = text.toLowerCase();

  const jv = scoreLexicon(lower, JAVANESE_WORDS);
  const su = scoreLexicon(lower, SUNDANESE_WORDS);

  if (jv.score > 0 && jv.score >= su.score) {
    return { language: "jv", confidence: Math.min(1, jv.score / 3), matchedWords: jv.matched };
  }
  if (su.score > 0) {
    return { language: "su", confidence: Math.min(1, su.score / 3), matchedWords: su.matched };
  }

  const informalHits = INFORMAL_MARKERS.filter((re) => re.test(lower)).length;
  if (informalHits >= 1) {
    return { language: "id_informal", confidence: Math.min(1, informalHits / 3), matchedWords: [] };
  }

  return { language: "id_formal", confidence: 0.5, matchedWords: [] };
}
