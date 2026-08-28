import { describe, expect, it } from 'vite-plus/test';
import { binaryPreviewKind, isSvgPath } from './binary-preview.ts';

describe('binaryPreviewKind', () => {
  it('maps raster-image extensions, case-insensitively', () => {
    expect(binaryPreviewKind('photo.PNG')).toEqual({ kind: 'image', mime: 'image/png' });
    expect(binaryPreviewKind('a/b/logo.jpeg')).toEqual({ kind: 'image', mime: 'image/jpeg' });
  });

  it('maps pdf and font extensions', () => {
    expect(binaryPreviewKind('doc.pdf')).toEqual({ kind: 'pdf', mime: 'application/pdf' });
    expect(binaryPreviewKind('font.ttf')).toEqual({ kind: 'font', mime: 'font/ttf' });
    expect(binaryPreviewKind('font.woff2')).toEqual({ kind: 'font', mime: 'font/woff2' });
  });

  it('returns null for non-previewable paths', () => {
    expect(binaryPreviewKind('main.ts')).toBeNull();
    expect(binaryPreviewKind('README')).toBeNull();
    expect(binaryPreviewKind('archive.zip')).toBeNull();
    expect(binaryPreviewKind('.gitignore')).toBeNull();
    expect(binaryPreviewKind('noext.')).toBeNull();
  });

  it('returns null for svg — previewed from text, never shipped as base64', () => {
    expect(binaryPreviewKind('image.svg')).toBeNull();
  });

  it('is not confused by a dotted directory name', () => {
    expect(binaryPreviewKind('assets.v2/readme')).toBeNull();
  });
});

describe('isSvgPath', () => {
  it('matches the .svg suffix case-insensitively', () => {
    expect(isSvgPath('logo.svg')).toBe(true);
    expect(isSvgPath('LOGO.SVG')).toBe(true);
    expect(isSvgPath('logo.svg.ts')).toBe(false);
  });
});
