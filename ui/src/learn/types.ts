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
  interviewQ: string;
  interviewA: string;
  wow: string;
  wowSource: string;
}
