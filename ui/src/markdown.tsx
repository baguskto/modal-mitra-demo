// Render markdown INLINE super-minimal (temuan QA minor m3: "**RST-MVTXDIR9**" tampil dengan
// bintang mentah di bubble chat) -- SENGAJA tanpa menambah dependency markdown penuh (bold,
// italic, inline code saja, cukup untuk gaya jawaban LLM di demo ini: **nomor tiket/RST/DSR**,
// `kode`, kadang _istilah_). Tidak men-render heading/list/link/HTML -- bukan markdown lengkap,
// dan TIDAK PERNAH menyisipkan HTML mentah (semua lewat React text nodes, aman dari XSS).
import type { ReactNode } from "react";

const TOKEN_RE = /(\*\*(?:[^*]+)\*\*|`(?:[^`]+)`|_(?:[^_]+)_)/g;

export function renderInlineMarkdown(text: string): ReactNode[] {
  const parts = text.split(TOKEN_RE);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <b key={i}>{part.slice(2, -2)}</b>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={i}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("_") && part.endsWith("_") && part.length > 2) {
      return <i key={i}>{part.slice(1, -1)}</i>;
    }
    return part;
  });
}
