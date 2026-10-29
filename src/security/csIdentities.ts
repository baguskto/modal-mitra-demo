// Identitas CS demo untuk four-eyes (temuan QA M5): SEBELUMNYA approver diketik bebas lewat
// window.prompt() — satu orang bisa mengetik 2 nama berbeda untuk melewati "2 approver berbeda".
// Demo ini tidak punya SSO/RBAC produksi (dicatat jujur di README sebagai USULAN produksi), tapi
// minimal: daftar identitas TETAP (bukan teks bebas), dipilih dari dropdown di Konsol CS
// (ui/src/csIdentities.ts — JAGA SINKRON dengan daftar ini), dan divalidasi lagi di server
// (lihat src/index.ts /api/cs/hitl/:id/approve) supaya request dengan `approver` di luar daftar
// ini DITOLAK (400), tidak bisa sembarang string.
export interface CsIdentity {
  id: string;
  name: string;
}

export const CS_IDENTITIES: CsIdentity[] = [
  { id: "cs-rina", name: "CS Rina" },
  { id: "cs-dimas", name: "Supervisor Dimas" },
];

export function isValidCsIdentity(id: string | undefined | null): CsIdentity | null {
  if (!id) return null;
  return CS_IDENTITIES.find((i) => i.id === id) ?? null;
}
