import { useEffect, useMemo, useState } from 'react';

// In-editor previews for the code browser's binary files (code.tsx): raster
// images, PDFs, fonts, plus rendered SVG. Repo content is untrusted — SVG
// only ever renders via <img> from a Blob URL, where scripts cannot execute;
// never dangerouslySetInnerHTML, <object>, or <iframe>.

// Mirror of the decode in repo-browser.ts (decodeBase64Text), minus the
// text step — the server already strips whitespace from the base64.
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  return Uint8Array.from(bin, (char) => char.charCodeAt(0));
}

function useBlobUrl(blob: Blob | null): string | null {
  const url = useMemo(() => (blob ? URL.createObjectURL(blob) : null), [blob]);
  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);
  return url;
}

// Checkerboard backdrop so transparent regions are visible, in the app's
// muted dark palette.
const CHECKERBOARD: React.CSSProperties = {
  background:
    'repeating-conic-gradient(var(--color-surface-2) 0% 25%, transparent 0% 50%) 50% / 20px 20px',
};

export function ImagePreview({ base64, mime, alt }: { base64: string; mime: string; alt: string }) {
  const blob = useMemo(() => new Blob([base64ToBytes(base64)], { type: mime }), [base64, mime]);
  const url = useBlobUrl(blob);
  if (!url) return null;
  return (
    <div className="flex h-full items-center justify-center p-4" style={CHECKERBOARD}>
      <img src={url} alt={alt} className="max-h-full max-w-full object-contain" />
    </div>
  );
}

export function PdfPreview({ base64, title }: { base64: string; title: string }) {
  // Blob URLs, not data: — Chromium blocks some data: navigations.
  const blob = useMemo(
    () => new Blob([base64ToBytes(base64)], { type: 'application/pdf' }),
    [base64],
  );
  const url = useBlobUrl(blob);
  if (!url) return null;
  return <iframe src={url} title={title} className="h-full w-full" />;
}

const SPECIMEN_LINES = [
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  'abcdefghijklmnopqrstuvwxyz',
  '0123456789',
  'The quick brown fox jumps over the lazy dog',
];
const SPECIMEN_SIZES = [12, 18, 28, 44];

export function FontPreview({ base64, family }: { base64: string; family: string }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const bytes = base64ToBytes(base64);
    // SAFETY: Uint8Array.from allocates a plain ArrayBuffer, never a
    // SharedArrayBuffer.
    const face = new FontFace(family, bytes.buffer as ArrayBuffer);
    let cancelled = false;
    face
      .load()
      .then(() => {
        if (cancelled) return;
        document.fonts.add(face);
        setReady(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      document.fonts.delete(face);
      setReady(false);
    };
  }, [base64, family]);
  if (!ready) return null;
  return (
    <div className="h-full overflow-auto p-6" style={{ fontFamily: family }}>
      {SPECIMEN_SIZES.map((size) => (
        <div key={size} className="mb-6 text-ink">
          {SPECIMEN_LINES.map((line) => (
            <p key={line} className="break-words" style={{ fontSize: size, lineHeight: 1.3 }}>
              {line}
            </p>
          ))}
        </div>
      ))}
    </div>
  );
}

export function SvgPreview({ text, alt }: { text: string; alt: string }) {
  const blob = useMemo(() => new Blob([text], { type: 'image/svg+xml' }), [text]);
  const url = useBlobUrl(blob);
  if (!url) return null;
  return (
    <div className="flex h-full items-center justify-center p-4" style={CHECKERBOARD}>
      <img src={url} alt={alt} className="max-h-full max-w-full object-contain" />
    </div>
  );
}
