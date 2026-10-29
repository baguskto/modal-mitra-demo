export interface DemoLink {
  /** Pesan yang otomatis dikirim ke chat demo (percakapan nyata, bukan rekaman palsu). */
  autosend: string;
  /** Buka panel Red Team Arena sekalian (untuk level 5b). */
  redteam?: boolean;
  /** Catatan kecil di bawah tombol, menjelaskan apa yang harus diperhatikan di X-Ray. */
  watchFor: string;
}

export interface FlowStep {
  label: string;
  sub?: string;
  /** Node ini yang paling relevan untuk level ini -> disorot statis saat reduced-motion. */
  highlight?: boolean;
  /** Node ini diblokir/ditolak dalam skenario yang digambarkan. */
  blocked?: boolean;
  /** Fitur diusulkan, belum diimplementasikan (ditandai jujur, garis putus-putus). */
  proposed?: boolean;
}

export interface LevelData {
  id: string;
  index: number | "5b";
  title: string;
  analogy: string;
  diagram:
    | { kind: "flow"; steps: FlowStep[] }
    | { kind: "castle" }
    | { kind: "map" };
  demo: DemoLink | null;
  // interviewQ/interviewA SENGAJA tidak ada di sini — presenter-only, diambil runtime dari
  // GET /api/presenter/qa (lihat src/data/presenterQa.ts, ui/src/learn/qa.ts), supaya tidak ikut
  // ter-bundle ke JS publik (temuan QA: 13 pasang Q&A sebelumnya bisa dibaca via view-source).
  wow: string;
  wowSource: string;
}
