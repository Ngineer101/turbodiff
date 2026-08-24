import { describe, expect, it } from 'vite-plus/test';
import { navShortcuts, nextIndex } from './shortcuts.ts';

describe('navShortcuts', () => {
  const nav = [
    { to: '/', label: 'Board' },
    { to: '/agents', label: 'Agents' },
    { to: '/skills', label: 'Skills' },
    { to: '/automations', label: 'Automations' },
    { to: '/integrations', label: 'Integrations' },
    { to: '/usage', label: 'Usage' },
    { to: '/settings', label: 'Settings' },
  ];

  it('assigns digits 1..n in nav order', () => {
    const shortcuts = navShortcuts(nav);
    expect(shortcuts.map((s) => s.key)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(shortcuts[0]).toEqual({ key: '1', to: '/', label: 'Board' });
    expect(shortcuts[6]).toEqual({ key: '7', to: '/settings', label: 'Settings' });
  });

  it('caps at nine entries — digits only', () => {
    const long = Array.from({ length: 12 }, (_, i) => ({ to: `/p${i}`, label: `P${i}` }));
    const shortcuts = navShortcuts(long);
    expect(shortcuts).toHaveLength(9);
    expect(shortcuts[8]).toEqual({ key: '9', to: '/p8', label: 'P8' });
  });
});

describe('nextIndex', () => {
  it('returns -1 for an empty list', () => {
    expect(nextIndex(-1, 0, 1)).toBe(-1);
    expect(nextIndex(0, 0, -1)).toBe(-1);
  });

  it('enters at the top moving down and the bottom moving up', () => {
    expect(nextIndex(-1, 5, 1)).toBe(0);
    expect(nextIndex(-1, 5, -1)).toBe(4);
  });

  it('steps within bounds and clamps at both ends', () => {
    expect(nextIndex(1, 5, 1)).toBe(2);
    expect(nextIndex(1, 5, -1)).toBe(0);
    expect(nextIndex(4, 5, 1)).toBe(4);
    expect(nextIndex(0, 5, -1)).toBe(0);
  });
});
