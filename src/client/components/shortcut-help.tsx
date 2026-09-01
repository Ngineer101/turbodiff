import { Code2, Compass, LayoutDashboard, List, type LucideIcon } from 'lucide-react';
import { useHotkeys } from 'react-hotkeys-hook';
import { navShortcuts, noOverlayOpen } from '../lib/shortcuts.ts';
import { useIsDesktop } from '../lib/use-is-desktop.ts';
import { Card } from './ui/card.tsx';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog.tsx';
import { Kbd } from './ui/kbd.tsx';

type ShortcutRow = { keys: string[]; label: string };
type ShortcutSection = { title: string; icon: LucideIcon; rows: ShortcutRow[] };

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

// Each shortcut group is a self-contained card: a labelled header over a
// divided list of rows. Cards flow into a masonry-style column layout so a
// tall group (Navigation) never leaves dead space beside a short one.
function SectionCard({ title, icon: Icon, rows }: ShortcutSection) {
  return (
    <Card className="mb-4 break-inside-avoid overflow-hidden p-0">
      <div className="flex items-center gap-2 border-b border-line/60 px-4 py-2.5">
        <Icon className="size-3.5 shrink-0 text-mute" aria-hidden />
        <h3 className="font-mono text-[11px] tracking-[0.14em] text-mute uppercase">{title}</h3>
      </div>
      <ul className="divide-y divide-line/40">
        {rows.map((row) => (
          <li
            key={row.label}
            className="flex items-center justify-between gap-4 px-4 py-2 text-[0.85rem] text-ink-dim"
          >
            <span className="min-w-0">{row.label}</span>
            <span className="flex shrink-0 items-center gap-1">
              {row.keys.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </Card>
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
    { keys: ['⌘B'], label: 'Collapse / expand the sidebar' },
    ...navShortcuts(nav).map((s) => ({ keys: [s.key], label: s.label })),
    { keys: ['?'], label: 'Keyboard shortcuts' },
  ];
  const sections: ShortcutSection[] = [
    { title: 'Navigation', icon: Compass, rows: navRows },
    { title: 'Board', icon: LayoutDashboard, rows: BOARD_ROWS },
    { title: 'Code browser', icon: Code2, rows: CODE_ROWS },
    { title: 'Lists', icon: List, rows: LIST_ROWS },
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85vh] max-w-lg flex-col p-0 sm:max-w-2xl lg:max-w-4xl"
        data-shortcut-help
      >
        <div className="border-b border-line px-5 py-4 sm:px-6">
          <DialogTitle className="text-base font-medium text-ink">Keyboard shortcuts</DialogTitle>
          <DialogDescription className="mt-1 text-[0.8rem] text-mute">
            Move around the whole app without leaving the keyboard. Press <Kbd>?</Kbd> anytime to
            bring this back.
          </DialogDescription>
        </div>
        {/* Body scrolls; the header and close button stay put. columns give a
            balanced masonry pack across the wider footprint on large screens. */}
        <div className="overflow-y-auto px-5 py-5 sm:px-6">
          <div className="gap-4 sm:columns-2 lg:columns-3">
            {sections.map((section) => (
              <SectionCard key={section.title} {...section} />
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
