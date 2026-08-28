// Extension classification for the code browser's binary previews, shared by
// the server adapters (to decide whether to ship base64 bytes) and the client
// (to decide how to render them). Keep this file dependency-free: it is
// type-checked in both the worker and client TypeScript programs.

export type BinaryPreviewKind = 'image' | 'pdf' | 'font';

// extension (lowercase, no dot) -> { kind, mime }. SVG is deliberately NOT
// here — it's text, delivered via `text` and previewed by the client from
// that, so the server never ships base64 for it.
const PREVIEWABLE: Record<string, { kind: BinaryPreviewKind; mime: string }> = {
  png: { kind: 'image', mime: 'image/png' },
  jpg: { kind: 'image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg' },
  gif: { kind: 'image', mime: 'image/gif' },
  webp: { kind: 'image', mime: 'image/webp' },
  ico: { kind: 'image', mime: 'image/x-icon' },
  bmp: { kind: 'image', mime: 'image/bmp' },
  avif: { kind: 'image', mime: 'image/avif' },
  pdf: { kind: 'pdf', mime: 'application/pdf' },
  ttf: { kind: 'font', mime: 'font/ttf' },
  otf: { kind: 'font', mime: 'font/otf' },
  woff: { kind: 'font', mime: 'font/woff' },
  woff2: { kind: 'font', mime: 'font/woff2' },
};

// Extension after the last `.` of the last path segment, lowercased. No dot,
// a trailing dot, and dotfiles (`.gitignore`) all mean no previewable kind.
export function binaryPreviewKind(
  path: string,
): { kind: BinaryPreviewKind; mime: string } | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  return PREVIEWABLE[name.slice(dot + 1).toLowerCase()] ?? null;
}

export function isSvgPath(path: string): boolean {
  return path.toLowerCase().endsWith('.svg');
}
