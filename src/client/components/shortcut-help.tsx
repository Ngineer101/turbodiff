import { useHotkeys } from 'react-hotkeys-hook';
import { navShortcuts, noOverlayOpen } from '../lib/shortcuts.ts';
import { useIsDesktop } from '../lib/use-is-desktop.ts';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog.tsx';
import { Kbd } from './ui/kbd.tsx';

type ShortcutRow = { keys: string[]; label: string };

const BOARD_ROWS: ShortcutRow[] = [
  { keys: ['/'], label: 'Focus quick-add' },
  { keys: ['j', 'k', '↓', '↑'], label: 'Next / previous card' },
  { keys: ['h', 'l', '←', '→'], label: 'Previous / next column' },
  { keys: ['Enter'], label: 'Open task · start todo (focused card)' },
  { keys: ['s'], label: 'Start todo (focused card)' },
  { keys: ['d'], label: 'Delete todo (focused card)' },
  { keys: ['e'], label: 'Archive task (focused card)' },
];

const CODE_ROWS: ShortcutRow[] = [
  { keys: ['⌘S'], label: 'Save the file (while editing)' },
  { keys: ['⌘F'], label: 'Find in file' },
  { keys: ['Tab'], label: 'Indent (Esc then Tab to move focus)' },
  { keys: ['↑', '↓', '←', '→'], label: 'Move through the file tree' },
];

const LIST_ROWS: ShortcutRow[] = [
  { keys: ['↑', '↓', 'Home', 'End'], label: 'Move through pickers and filters' },
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
// SIDEBAR_NAV) so app-shell → shortcut-help stays a one-way import. Open
// state lives in the caller so the sidebar's Shortcuts button and "?" share
// it — and "?" closes the sheet it opened (its own dialog doesn't count as
// a blocking overlay).
export function ShortcutHelp({
  nav,
  open,
  onOpenChange,
  onToggle,
}: {
  nav: readonly { to: string; label: string }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Functional toggle from the owner, so the hotkey never acts on a stale
  // `open` captured in the library's memoized callback/options.
  onToggle: () => void;
}) {
  const isDesktop = useIsDesktop();
  // DOM-based gate (no captured state): fire when nothing overlays, or when
  // the open overlay is this sheet itself — so "?" also closes it.
  const enabled = () =>
    isDesktop && (noOverlayOpen() || document.querySelector('[data-shortcut-help]') !== null);
  // Typing "?" holds Shift on most layouts, and the key-matcher rejects a
  // held modifier the hotkey spec doesn't name — so bind the physical
  // shift+slash chord, plus bare "?" for layouts where it's unshifted.
  useHotkeys('shift+slash', onToggle, { enabled }, [isDesktop]);
  useHotkeys('?', onToggle, { useKey: true, enabled }, [isDesktop]);
  const navRows: ShortcutRow[] = [
    { keys: ['⌘K'], label: 'Jump to a page, task, or repo' },
    ...navShortcuts(nav).map((s) => ({ keys: [s.key], label: s.label })),
    { keys: ['?'], label: 'Keyboard shortcuts' },
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-shortcut-help>
        <DialogTitle className="text-base font-medium">Keyboard shortcuts</DialogTitle>
        <div className="mt-4 grid gap-x-8 gap-y-5 sm:grid-cols-2">
          <Section title="Navigation" rows={navRows} />
          <div className="space-y-5">
            <Section title="Board" rows={BOARD_ROWS} />
            <Section title="Code browser" rows={CODE_ROWS} />
            <Section title="Lists" rows={LIST_ROWS} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
