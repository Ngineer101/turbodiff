import { describe, expect, it } from 'vite-plus/test';
import { codeRoute } from './layout.ts';

describe('codeRoute', () => {
  it('matches the code browser for GitHub repo ids', () => {
    expect(codeRoute('/repos/1257539637/code/')).toBe(true);
    expect(codeRoute('/repos/1/code/src/http/api.ts')).toBe(true);
  });

  it('matches Artifacts repos, whose synthetic ids are negative', () => {
    expect(codeRoute('/repos/-1/code')).toBe(true);
    expect(codeRoute('/repos/-42/code/src/main.tsx')).toBe(true);
  });

  it('matches nothing else', () => {
    expect(codeRoute('/')).toBe(false);
    expect(codeRoute('/factory/features/56')).toBe(false);
    expect(codeRoute('/repos/abc/code')).toBe(false);
    expect(codeRoute('/repos/1/settings')).toBe(false);
  });
});
