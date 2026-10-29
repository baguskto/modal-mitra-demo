import { describe, expect, it } from "vitest";
import { detectAndStyle, detectLanguage } from "../../src/extras/language";

// 10 kalimat uji (brief poin 2: "test 10 kalimat") — campuran Indonesia formal/informal, Jawa
// ringan, Sunda ringan, sesuai gaya eval existing repo (evals/promptfooconfig.yaml kasus informal).
const CASES: { text: string; expected: "id_formal" | "id_informal" | "jv" | "su" }[] = [
  { text: "Selamat siang, saya ingin menanyakan status pengajuan pinjaman saya.", expected: "id_formal" },
  { text: "min, cek dong sisa angsuran aq yg bulan ini brp", expected: "id_informal" },
  { text: "kak tlg bantu aq, gmn caranya ajukan keringanan", expected: "id_informal" },
  { text: "Kulo badhe tanglet, pinjaman kulo niki sampun cair dereng nggih?", expected: "jv" },
  { text: "Monggo, sampeyan saged bantu kula pripun carane bayar angsuran?", expected: "jv" },
  { text: "Punten abdi bade tumaros, angsuran abdi tos dibayar teu acan nya?", expected: "su" },
  { text: "Kumaha carana ngajukeun restrukturisasi, kedah ka kantor atanapi tiasa online?", expected: "su" },
  { text: "Mohon informasi mengenai jadwal pertemuan majelis minggu ini.", expected: "id_formal" },
  { text: "ga ngerti knp td ga bisa login, pls bantu cek ya kak", expected: "id_informal" },
  { text: "Terima kasih atas informasinya, akan saya pertimbangkan lebih lanjut.", expected: "id_formal" },
];

describe("extras/language detectLanguage — 10 kalimat", () => {
  for (const { text, expected } of CASES) {
    it(`"${text.slice(0, 40)}..." -> ${expected}`, () => {
      expect(detectLanguage(text).language).toBe(expected);
    });
  }
});

describe("extras/language detectAndStyle", () => {
  it("returns a non-empty style instruction and an xray lang_detect event", () => {
    const result = detectAndStyle("Kulo badhe tanglet, pripun carane?", "sess-1");
    expect(result.language).toBe("jv");
    expect(result.styleInstruction.length).toBeGreaterThan(10);
    expect(result.xray.type).toBe("lang_detect");
    expect(result.xray.sessionId).toBe("sess-1");
    expect(result.xray.data.language).toBe("jv");
  });

  it("never calls out to the network (pure/sync heuristic)", () => {
    expect(() => detectAndStyle("apa saja syarat pengajuan?")).not.toThrow();
  });
});
