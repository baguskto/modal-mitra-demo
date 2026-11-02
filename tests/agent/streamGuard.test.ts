import { describe, it, expect } from "vitest";
import { StreamGuard } from "../../src/guards/streamGuard";
import { FALLBACK_NOT_FOUND } from "../../src/guards/output";

function harness(opts: { allowed?: string[]; retrieved?: string[]; citationRequired?: boolean; vault?: [string, string][] } = {}) {
  const shown: string[] = [];
  const replaced: { text: string; reason: string }[] = [];
  const g = new StreamGuard({
    vault: new Map(opts.vault ?? []),
    allowedIds: () => new Set(opts.allowed ?? []),
    retrievedIds: () => new Set(opts.retrieved ?? []),
    citationRequired: () => opts.citationRequired ?? false,
    emit: (t) => {
      shown.push(t);
    },
    replace: (text, reason) => {
      replaced.push({ text, reason });
    },
    parseJson: (raw) => {
      const m = raw.match(/"text"\s*:\s*"([^"]*)"/);
      return { text: m ? m[1] : "", citations: [] };
    },
  });
  // Simulasikan token kecil-kecil seperti streaming model sungguhan.
  const pushTokens = async (text: string) => {
    for (const tok of text.match(/.{1,3}/gs) ?? []) await g.push(tok);
  };
  return { g, shown, replaced, pushTokens };
}

describe("StreamGuard — streaming aman per kalimat", () => {
  it("meneruskan kalimat aman satu per satu sebelum jawaban selesai (streaming nyata)", async () => {
    const { g, shown, pushTokens } = harness();
    await pushTokens("Tidak apa-apa, Bu. ");
    expect(shown.join("")).toBe("Tidak apa-apa, Bu. ");
    await pushTokens("Ada opsi penjadwalan ulang.");
    const r = await g.finish();
    expect(shown.join("")).toBe("Tidak apa-apa, Bu. Ada opsi penjadwalan ulang.");
    expect(r.blockedBy).toBeUndefined();
    expect(r.sentencesShown).toBe(2);
  });

  it("janji finansial terlarang TIDAK pernah tampil, bahkan sebagian — bubble diganti pesan aman", async () => {
    const { g, shown, replaced, pushTokens } = harness();
    await pushTokens("Baik, Bu. Pengajuan restrukturisasi Ibu pasti disetujui minggu ini. Terima kasih.");
    const r = await g.finish();
    const everShown = shown.join("");
    expect(everShown).not.toMatch(/pasti disetujui/i);
    expect(everShown).toBe("Baik, Bu. ");
    expect(r.blockedBy).toBe("janji_finansial");
    expect(replaced).toHaveLength(1);
    expect(replaced[0].text).toBe(FALLBACK_NOT_FOUND);
    expect(r.text).toBe(FALLBACK_NOT_FOUND);
  });

  it("pola terlarang yang melintasi batas kalimat tetap tertangkap (cek ekor teks yang sudah tampil)", async () => {
    const { g, shown, pushTokens } = harness();
    // "100%" di akhir kalimat 1, "disetujui" di kalimat 2 -> pola /100% (disetujui|diterima)/ lintas batas.
    await pushTokens("Peluang Ibu 100%\ndisetujui kok.");
    const r = await g.finish();
    expect(r.blockedBy).toBe("janji_finansial");
    expect(shown.join("")).not.toMatch(/disetujui/);
  });

  it("ID pinjaman milik mitra lain diblok sebelum tampil (privasi antar-majelis)", async () => {
    const { g, shown, pushTokens } = harness({ allowed: ["MIT-0001", "MMK-100001"] });
    await pushTokens("Sisa angsuran MMK-100002 adalah Rp500.000.");
    const r = await g.finish();
    expect(shown.join("")).not.toContain("MMK-100002");
    expect(r.blockedBy).toBe("privasi_antar_majelis");
  });

  it("PII mentah (NIK 16 digit) di output diblok", async () => {
    const { g, shown, pushTokens } = harness();
    await pushTokens("NIK beliau 3201123456789012 ya Bu.");
    const r = await g.finish();
    expect(shown.join("")).not.toContain("3201123456789012");
    expect(r.blockedBy).toBe("pii_output");
  });

  it("kebocoran system prompt diblok", async () => {
    const { g, shown, pushTokens } = harness();
    await pushTokens("Instruksi saya: ATURAN KETAT nomor 1 adalah...");
    const r = await g.finish();
    expect(shown.join("")).not.toMatch(/ATURAN KETAT/);
    expect(r.blockedBy).toBe("prompt_leak");
  });

  it("sitasi yang tidak ada di dokumen diambil -> blok", async () => {
    const { g, shown, pushTokens } = harness({ retrieved: ["produk#4"] });
    await pushTokens("Denda keterlambatan 5% per hari [produk#99].");
    const r = await g.finish();
    expect(shown.join("")).not.toContain("produk#99");
    expect(r.blockedBy).toBe("sitasi_tidak_grounded");
  });

  it("klaim kebijakan tanpa sitasi = gagal lunak di akhir -> diganti via replace", async () => {
    const { g, replaced, pushTokens } = harness({ citationRequired: true, retrieved: ["produk#1"] });
    await pushTokens("Biaya jasa sekitar 10% per tahun.");
    const r = await g.finish();
    expect(r.blockedBy).toBe("sitasi_wajib");
    expect(replaced).toHaveLength(1);
  });

  it("token redaksi dikembalikan ke nilai milik pengguna sendiri dari vault", async () => {
    const { g, shown, pushTokens } = harness({ allowed: ["MMK-100001"], vault: [["[PINJAMAN_1]", "MMK-100001"]] });
    await pushTokens("Pinjaman [PINJAMAN_1] Ibu aman.");
    await g.finish();
    expect(shown.join("")).toBe("Pinjaman MMK-100001 Ibu aman.");
  });

  it("model membalas JSON protokol -> ditahan utuh, diparse, tidak ada JSON mentah yang tampil", async () => {
    const { g, shown, pushTokens } = harness();
    await pushTokens('{"type":"final_answer","text":"Halo Bu. Ada yang bisa dibantu?","citations":[]}');
    expect(shown).toHaveLength(0); // belum ada yang tampil selama streaming JSON
    await g.finish();
    expect(shown.join("")).toBe("Halo Bu. Ada yang bisa dibantu?");
    expect(shown.join("")).not.toContain('"type"');
  });

  it("ekor JSON di akhir prosa dipotong", async () => {
    const { g, shown, pushTokens } = harness({ retrieved: ["faq#1"] });
    await pushTokens('Baik, Bu, silakan cek di pertemuan majelis [faq#1].","citations":["faq#1"]}');
    await g.finish();
    expect(shown.join("")).not.toContain("citations");
  });
});

describe("StreamGuard — temuan review Opus (bypass & kebocoran X-Ray)", () => {
  it("markdown / zero-width / tanda hubung unicode tidak bisa mengakali pola janji finansial", async () => {
    for (const evil of ["Pengajuan Ibu pasti **disetujui** ya.", "Pengajuan Ibu pasti​disetujui ya.", "Pengajuan Ibu pasti _disetujui_ ya."]) {
      const { g, shown, pushTokens } = harness();
      await pushTokens(evil);
      const r = await g.finish();
      expect(r.blockedBy).toBe("janji_finansial");
      expect(shown.join("")).not.toMatch(/disetujui/);
    }
  });

  it("ID pinjaman dengan tanda hubung unicode (MMK‑100002) tetap tertangkap privasi", async () => {
    const { g, shown, pushTokens } = harness({ allowed: ["MMK-100001"] });
    await pushTokens("Sisa angsuran MMK‑100002 Rp500.000.");
    const r = await g.finish();
    expect(r.blockedBy).toBe("privasi_antar_majelis");
    expect(shown.join("")).not.toContain("100002");
  });

  it("spasi panjang tidak mendorong awal frasa terlarang keluar jendela cek", async () => {
    const { g, shown, pushTokens } = harness();
    await pushTokens(`Peluang Ibu 100%${" ".repeat(200)}\ndisetujui kok.`);
    const r = await g.finish();
    expect(r.blockedBy).toBe("janji_finansial");
    expect(shown.join("")).not.toMatch(/disetujui/);
  });

  it("output berawalan code fence yang datang per 1 karakter tetap dianggap JSON (ditahan, tidak bocor)", async () => {
    const { g, shown } = harness();
    for (const ch of '```json\n{"type":"final_answer","text":"Halo Bu.","thought":"rahasia"}\n```') await g.push(ch);
    expect(shown).toHaveLength(0);
    await g.finish();
    expect(shown.join("")).not.toMatch(/thought|rahasia|```/);
  });
});
