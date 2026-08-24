import type { KeyboardEvent } from 'react';

// Keyboard-shortcut helpers. The pure functions stay DOM-free so they run
// under the plugin-free vitest config; the DOM-touching ones live below.

// Derive digit shortcuts from a nav list (single source of truth is
// SIDEBAR_NAV in app-shell.tsx). Digits only, so at most nine entries.
export function navShortcuts(
  nav: readonly { to: string; label: string }[],
): { key: string; to: string; label: string }[] {
  return nav.slice(0, 9).map((item, i) => ({ key: String(i + 1), to: item.to, label: item.label }));
}

// Next index for listbox/roving movement, clamped at both ends. With no
// current selection, moving down enters at the top and up at the bottom.
export function nextIndex(current: number, count: number, dir: 1 | -1): number {
  if (count === 0) return -1;
  if (current < 0) return dir === 1 ? 0 : count - 1;
  return Math.min(count - 1, Math.max(0, current + dir));
}

// True when no Radix dialog/popover layer is open. Radix DialogContent renders
// role="dialog"; popovers portal inside [data-radix-popper-content-wrapper].
export function noOverlayOpen(): boolean {
  return !document.querySelector('[role="dialog"], [data-radix-popper-content-wrapper]');
}

// Shared onKeyDown for the hand-rolled role="listbox" popovers: moves DOM
// focus among enabled [role="option"] buttons inside e.currentTarget.
// Anything unhandled falls through so typing keeps working in the filter
// input; preventDefault only when a move happened.
export function onListboxKeyDown(e: KeyboardEvent<HTMLElement>): void {
  const options = [
    ...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)'),
  ];
  if (options.length === 0) return;
  const current = options.findIndex((el) => el === document.activeElement);
  let target: number;
  if (e.key === 'ArrowDown') target = nextIndex(current, options.length, 1);
  else if (e.key === 'ArrowUp') target = nextIndex(current, options.length, -1);
  else if (e.key === 'Home') target = 0;
  else if (e.key === 'End') target = options.length - 1;
  else return;
  options[target]?.focus();
  e.preventDefault();
}
