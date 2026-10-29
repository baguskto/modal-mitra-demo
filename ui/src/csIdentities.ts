// SINKRON dengan src/security/csIdentities.ts (server) -- daftar identitas CS demo TETAP untuk
// four-eyes (temuan QA M5), dipilih dari dropdown, BUKAN diketik bebas lewat window.prompt().
export interface CsIdentity {
  id: string;
  name: string;
}

export const CS_IDENTITIES: CsIdentity[] = [
  { id: "cs-rina", name: "CS Rina" },
  { id: "cs-dimas", name: "Supervisor Dimas" },
];
