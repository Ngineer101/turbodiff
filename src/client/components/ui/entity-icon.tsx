import {
  Accessibility,
  Activity,
  Bot,
  Database,
  FlaskConical,
  Gauge,
  Repeat,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Wand2,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../../lib/utils.ts';

export type EntityKind = 'agent' | 'skill' | 'automation';

// Keyword → glyph, matched against the slug + name. Lets built-ins *and*
// meaningfully-named custom entities get a fitting icon; anything unmatched
// falls back to the per-kind default. Order matters — first hit wins.
const KEYWORD_ICONS: [RegExp, LucideIcon][] = [
  [/access|a11y/, Accessibility],
  [/secur|vuln|audit|threat/, ShieldCheck],
  [/perf|speed|latency|n\+1/, Gauge],
  [/test|spec|qa/, FlaskConical],
  [/lint|format|style|fix/, Wand2],
  [/db|migrat|schema|sql/, Database],
  [/shell|bash|script|terminal/, SquareTerminal],
  [/review|scan|inspect/, ScanSearch],
  [/observ|o11y|log|metric|trace|monitor/, Activity],
];

const KIND_DEFAULT: Record<EntityKind, LucideIcon> = {
  agent: Bot,
  skill: Sparkles,
  automation: Repeat,
};

export function entityIcon(kind: EntityKind, slug: string, name = ''): LucideIcon {
  const hay = `${slug} ${name}`.toLowerCase();
  for (const [pattern, icon] of KEYWORD_ICONS) if (pattern.test(hay)) return icon;
  return KIND_DEFAULT[kind];
}

const BOX = { sm: 'size-8 rounded-lg', md: 'size-10 rounded-xl', lg: 'size-11 rounded-xl' };
const GLYPH = { sm: 'size-4', md: 'size-5', lg: 'size-[1.4rem]' };

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
  const Icon = entityIcon(kind, slug, name);
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
