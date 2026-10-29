import { describe, expect, it } from "vitest";
import { redactPII, resolveLeakedTokensInText, scanOutputForPII } from "../../src/guards/pii";

// Temuan QA #g: audit log `query_redacted` sebelumnya masih memuat tanggal lahir informal
// ("tgl lahir 12 maret 1985", "12/03/1985") karena pola TANGGAL lama hanya menangkap format ISO
// (YYYY-MM-DD). Uji semua format yang sekarang wajib tertangkap, plus NIK/HP/email yang sudah ada.
describe("guards/pii redactPII — tanggal lahir informal", () => {
  it("meredaksi tanggal ISO (format lama, regresi)", () => {
    const { redacted, matches } = redactPII("tanggal lahir saya 1985-03-12");
    expect(redacted).not.toContain("1985-03-12");
    expect(matches.some((m) => m.type === "TANGGAL")).toBe(true);
  });

  it("meredaksi tanggal DD/MM/YYYY", () => {
    const { redacted } = redactPII("tgl lahir 12/03/1985 ya bu");
    expect(redacted).not.toContain("12/03/1985");
  });

  it("meredaksi tanggal DD-MM-YYYY", () => {
    const { redacted } = redactPII("tgl lahir 12-03-1985 ya bu");
    expect(redacted).not.toContain("12-03-1985");
  });

  it("meredaksi tanggal informal 'DD <bulan> YYYY' (Bahasa Indonesia)", () => {
    const { redacted } = redactPII("tanggal lahir saya 12 maret 1985 kak");
    expect(redacted).not.toContain("12 maret 1985");
  });

  it("meredaksi tanggal informal dengan nama bulan huruf besar", () => {
    const { redacted } = redactPII("lahir tanggal 3 Oktober 1990");
    expect(redacted).not.toContain("3 Oktober 1990");
  });

  it("tetap meredaksi NIK 16 digit", () => {
    const { redacted } = redactPII("NIK saya 1234567890123456");
    expect(redacted).not.toContain("1234567890123456");
  });

  it("tetap meredaksi nomor HP", () => {
    const { redacted } = redactPII("nomor saya 081234567890 bisa dihubungi");
    expect(redacted).not.toContain("081234567890");
  });

  it("tetap meredaksi email", () => {
    const { redacted } = redactPII("email saya andi@example.test");
    expect(redacted).not.toContain("andi@example.test");
  });

  it("resolveLeakedTokensInText mengembalikan nilai asli dari vault", () => {
    const { redacted, matches } = redactPII("tgl lahir 12 maret 1985");
    const vault = new Map(matches.map((m) => [m.token, m.original] as [string, string]));
    const resolved = resolveLeakedTokensInText(redacted, vault);
    expect(resolved).toContain("12 maret 1985");
  });

  it("scanOutputForPII tidak menandai TANGGAL (sesuai desain: tanggal milik user sendiri wajar muncul di jawaban)", () => {
    const result = scanOutputForPII("Tanggal lahir Anda tercatat 12 maret 1985.");
    expect(result.clean).toBe(true);
  });

  it("scanOutputForPII tetap menandai NIK/email/HP mentah di output", () => {
    const result = scanOutputForPII("NIK Anda 1234567890123456, HP 081234567890, email andi@example.test");
    expect(result.clean).toBe(false);
    expect(result.findings.length).toBeGreaterThan(0);
  });
});
