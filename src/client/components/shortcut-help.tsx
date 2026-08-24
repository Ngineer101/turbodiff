import { useState } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { navShortcuts, noOverlayOpen } from '../lib/shortcuts.ts';
import { useIsDesktop } from '../lib/use-is-desktop.ts';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog.tsx';
import { Kbd } from './ui/kbd.tsx';

type ShortcutRow = { keys: string[]; label: string };

const BOARD_ROWS: ShortcutRow[] = [
  { keys: ['/'], label: 'Focus quick-add' },
  { keys: ['j', 'k'], label: 'Next / previous card' },
  { keys: ['h', 'l'], label: 'Previous / next column' },
  { keys: ['Enter'], label: 'Open card' },
  { keys: ['s'], label: 'Start todo' },
  { keys: ['d'], label: 'Delete todo' },
  { keys: ['e'], label: 'Archive task' },
];

function Section({ title, rows }: { title: string; rows: ShortcutRow[] }) {
  return (
    <div>
      <h3 className="font-mono text-[11px] tracking-[0.14em] text-mute uppercase">{title}</h3>
      <ul className="mt-2 space-y-1.5">
        {rows.map((row) => (
          <li
            key={row.label}
            className="flex items-center justify-between gap-3 text-[0.85rem] text-ink-dim"
          >
            <span>{row.label}</span>
            <span className="flex items-center gap-1">
              {row.keys.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// The "?" cheat sheet. Takes the nav list as a prop (rather than importing
// SIDEBAR_NAV) so app-shell → shortcut-help stays a one-way import. The
// overlay guard means "?" only opens it; closing is Escape/✕ via Radix.
export function ShortcutHelp({ nav }: { nav: readonly { to: string; label: string }[] }) {
  const isDesktop = useIsDesktop();
  const [open, setOpen] = useState(false);
  useHotkeys(
    '?',
    () => setOpen((o) => !o),
    {
      useKey: true,
      enabled: () => isDesktop && noOverlayOpen(),
    },
    [isDesktop],
  );
  const navRows: ShortcutRow[] = [
    ...navShortcuts(nav).map((s) => ({ keys: [s.key], label: s.label })),
    { keys: ['?'], label: 'Keyboard shortcuts' },
  ];
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogTitle className="text-base font-medium">Keyboard shortcuts</DialogTitle>
        <div className="mt-4 space-y-5">
          <Section title="Navigation" rows={navRows} />
          <Section title="Board" rows={BOARD_ROWS} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
