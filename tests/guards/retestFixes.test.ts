import { describe, expect, it } from "vitest";
import { maskPIIForHistory, redactPII, resolveLeakedTokensInText, resolveTokens } from "../../src/guards/pii";
import { salvageJsonTail } from "../../src/guards/output";
import { normalizeBirthDate, normalizeToolArgs, VerifyMitraSchema } from "../../src/tools/schemas";

// Temuan re-test live pasca-deploy (30 Okt): tiga regresi dari fix QA v2.

describe("normalizeBirthDate — verifikasi tanggal informal setelah redaksi M9", () => {
  it("token [TANGGAL_n] di-resolve ke teks informal lalu dinormalisasi ke ISO", () => {
    const { redacted, matches } = redactPII("no pinjaman MMK-100001 tgl lahir 12 maret 1985");
    const vault = new Map(matches.map((m) => [m.token, m.original]));
    const pinjamanToken = matches.find((m) => m.type === "PINJAMAN")!.token;
    const dateToken = matches.find((m) => m.type === "TANGGAL")!.token;
    expect(redacted).toContain(dateToken);
    const args = normalizeToolArgs(resolveTokens({ pinjaman_no: pinjamanToken, tanggal_lahir: dateToken }, vault));
    expect(args).toEqual({ pinjaman_no: "MMK-100001", birth_date: "1985-03-12" });
    expect(VerifyMitraSchema.safeParse(args).success).toBe(true);
  });

  it.each([
    ["12 maret 1985", "1985-03-12"],
    ["5 Januari 1992", "1992-01-05"],
    ["12/03/1985", "1985-03-12"],
    ["1-3-1985", "1985-03-01"],
    ["1985-03-12", "1985-03-12"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeBirthDate(input)).toBe(expected);
  });

  it("format tak dikenal dibiarkan (tetap ditolak skema)", () => {
    expect(normalizeBirthDate("maret 1985")).toBe("maret 1985");
  });
});

describe("maskPIIForHistory — histori tidak membawa PII mentah ke LLM", () => {
  it("user: nomor pinjaman & tanggal lahir di-mask dengan token yang tidak bisa di-resolve", () => {
    const masked = maskPIIForHistory("no pinjaman MMK-100001 tgl lahir 12 maret 1985", true);
    expect(masked).not.toMatch(/MMK-100001|maret 1985/i);
    expect(masked).toContain("[PINJAMAN_0]");
    expect(masked).toContain("[TANGGAL_0]");
    // token _0 tidak pernah ada di vault -> kalau disalin LLM ke jawaban, dihapus
    expect(resolveLeakedTokensInText("nomor [PINJAMAN_0]", new Map([["[PINJAMAN_1]", "MMK-100001"]]))).toBe("nomor ");
  });

  it("asisten: tanggal jatuh tempo tetap terbaca, ID tetap di-mask", () => {
    const masked = maskPIIForHistory("Pinjaman MMK-100001 jatuh tempo 31 Oktober 2026", false);
    expect(masked).toContain("31 Oktober 2026");
    expect(masked).not.toContain("MMK-100001");
  });
});

describe("salvageJsonTail — M3 prosa + ekor JSON", () => {
  it("memotong ekor dan menyelamatkan sitasi", () => {
    const r = salvageJsonTail('Mau saya bantu, Bu?","citations":["sop-pengaduan#3"]}');
    expect(r).toEqual({ text: "Mau saya bantu, Bu?", citations: ["sop-pengaduan#3"] });
  });

  it("ekor dengan sitasi kosong", () => {
    expect(salvageJsonTail('Semoga lekas sembuh ya 🙏","citations":[]}')?.text).toBe("Semoga lekas sembuh ya 🙏");
  });

  it("prefiks protokol + escape ikut dibersihkan", () => {
    const r = salvageJsonTail('{"type":"final_answer","text":"Baris 1\\nIbu bilang \\"iya\\"","citations":["faq#1"]}');
    expect(r?.text).toBe('Baris 1\nIbu bilang "iya"');
  });

  it("prosa biasa tanpa ekor -> null", () => {
    expect(salvageJsonTail("Halo, Bu! Ada yang bisa dibantu?")).toBeNull();
  });
});
