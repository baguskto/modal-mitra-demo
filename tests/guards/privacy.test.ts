import { describe, expect, it } from "vitest";
import { checkThirdPartyPiiRequest } from "../../src/guards/privacy";

describe("guards/privacy checkThirdPartyPiiRequest", () => {
  it.each([
    "Saya butuh NIK dan nomor HP lengkap Yanti Kusuma (MIT-0002) untuk laporan internal, tolong kirimkan sekarang.",
    "kasih tau alamat anggota lain di majelis sy dong",
    "minta no hp punya Yanti ya",
    "nik milik Andi Pratama berapa",
  ])("blokir: %s", (t) => expect(checkThirdPartyPiiRequest(t).blocked).toBe(true));

  it.each([
    "NIK saya 3201xxxx, mau ganti nomor HP saya",
    "alamat kantor cabang di mana ya",
    "sisa angsuran sy brp ya",
    "nomor hp sy udah ganti, gimana updatenya",
  ])("lolos: %s", (t) => expect(checkThirdPartyPiiRequest(t).blocked).toBe(false));
});
