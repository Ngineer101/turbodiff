import {
  Accessibility,
  Activity,
  Bot,
  Database,
  FlaskConical,
  Gauge,
  Plug,
  Repeat,
  ScanSearch,
  Server,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Wand2,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../../lib/utils.ts';

export type EntityKind = 'agent' | 'skill' | 'automation' | 'integration';

// Keyword → glyph, matched against the slug + name. Lets built-ins *and*
// meaningfully-named custom entities get a fitting icon; anything unmatched
// falls back to the per-kind default. Order matters — first hit wins.
const KEYWORD_ICONS: [RegExp, LucideIcon][] = [
  [/access|a11y/, Accessibility],
  [/secur|vuln|audit|threat/, ShieldCheck],
  [/perf|speed|latency|n\+1/, Gauge],
  [/test|spec|qa/, FlaskConical],
  [/lint|format|style|fix/, Wand2],
  [/db|migrat|schema|sql|postgres|redis|mysql/, Database],
  [/shell|bash|script|terminal/, SquareTerminal],
  [/review|scan|inspect/, ScanSearch],
  [/observ|o11y|log|metric|trace|monitor/, Activity],
  [/mcp|server/, Server],
];

const KIND_DEFAULT = {
  agent: Bot,
  skill: Sparkles,
  automation: Repeat,
  integration: Plug,
} satisfies Record<EntityKind, LucideIcon>;

export function entityIcon(kind: EntityKind, slug: string, name = ''): LucideIcon {
  const hay = `${slug} ${name}`.toLowerCase();
  for (const [pattern, icon] of KEYWORD_ICONS) if (pattern.test(hay)) return icon;
  return KIND_DEFAULT[kind];
}

const BOX = { sm: 'size-8 rounded-lg', md: 'size-10 rounded-xl', lg: 'size-11 rounded-xl' };
const GLYPH = { sm: 'size-4', md: 'size-5', lg: 'size-[1.4rem]' };

// The accent-tinted rounded tile, given any icon — the shared visual anchor
// used by entity cards/forms and by page headers (settings, members, …).
export function IconTile({
  icon: Icon,
  size = 'md',
  className,
}: {
  icon: LucideIcon;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center border border-accent/20 bg-accent/10 text-accent-bright',
        BOX[size],
        className,
      )}
      aria-hidden
    >
      <Icon className={GLYPH[size]} />
    </span>
  );
}

// The accent-tinted tile that anchors every entity — list card, and the
// create/edit header. One shared identity across agents, skills, and
// automations. Pass an empty slug to get the kind's default glyph (used for
// the page/type icon rather than a specific entity).
export function EntityIcon({
  kind,
  slug = '',
  name,
  size = 'md',
  className,
}: {
  kind: EntityKind;
  slug?: string;
  name?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  return <IconTile icon={entityIcon(kind, slug, name)} size={size} className={className} />;
}
