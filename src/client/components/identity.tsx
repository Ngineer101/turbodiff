import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/utils.ts';

// The B+A identity kit. Two vocabularies, one rule:
//   - Control Room (Lamp, Placard, StageLights, TelemetryStrip) renders LIVE
//     state — things still moving.
//   - Job Ticket (Serial, Stamp, Ledger, CertStrip) renders OUTCOMES — things
//     finished and proven.
// Every element also carries its meaning as text, so nothing depends on
// color or glow alone.

export type LampTone = 'go' | 'hold' | 'off' | 'abort';

const LAMP_DOT: Record<LampTone, string> = {
  go: 'bg-accent-bright lamp-glow-go',
  hold: 'bg-hold lamp-glow-hold',
  abort: 'bg-danger lamp-glow-abort',
  off: 'bg-line-2',
};

export function Lamp({
  tone,
  pulse = false,
  className,
}: {
  tone: LampTone;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        LAMP_DOT[tone],
        pulse && 'animate-pulse-dot',
        className,
      )}
    />
  );
}

// Placard: the uppercase tracked label that names a station, column, or
// panel — always paired with a lamp when it describes live state.
export function Placard({
  children,
  lamp,
  pulse,
  aside,
  className,
}: {
  children: ReactNode;
  lamp?: LampTone;
  pulse?: boolean;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 rounded-md border border-line bg-surface px-3 py-1.5',
        'font-mono text-[10px] font-semibold tracking-[0.18em] text-ink-dim uppercase',
        className,
      )}
    >
      {lamp ? <Lamp tone={lamp} pulse={pulse} /> : null}
      <span className="min-w-0 truncate">{children}</span>
      {aside !== undefined ? (
        <span className="ml-auto shrink-0 font-normal text-mute">{aside}</span>
      ) : null}
    </div>
  );
}

// Serial: the job-ticket number. Tasks and features are numbered work, and
// the number is the identity that survives onto the certificate.
export function Serial({ n, className }: { n: number; className?: string }) {
  return (
    <span
      className={cn('font-mono text-[10px] tracking-[0.18em] text-mute tabular-nums', className)}
    >
      TD-{String(n).padStart(4, '0')}
    </span>
  );
}

// Stamp: an outcome, stamped on the work. Reserved for terminal states —
// never for anything still moving (that's what lamps are for).
export function Stamp({
  children,
  tone = 'ok',
  className,
}: {
  children: ReactNode;
  tone?: 'ok' | 'warn' | 'red';
  className?: string;
}) {
  return (
    <span
      className={cn(
        'stamp text-[11px]',
        tone === 'ok' && 'text-accent-bright',
        tone === 'warn' && 'text-hold',
        tone === 'red' && 'text-danger',
        className,
      )}
    >
      {children}
    </span>
  );
}

// Ledger: the job ticket's footer row — small labeled figures, tabular.
export function Ledger({
  items,
  className,
}: {
  items: { label: string; value: ReactNode; tone?: 'hold' | 'go' }[];
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex gap-4 border-t border-line pt-2 font-mono text-[10px] text-ink-dim tabular-nums',
        className,
      )}
    >
      {items.map((it) => (
        <div key={it.label} className="min-w-0">
          <div className="text-[8.5px] tracking-[0.14em] text-mute uppercase">{it.label}</div>
          <div
            className={cn(
              'truncate',
              it.tone === 'hold' && 'text-hold',
              it.tone === 'go' && 'text-accent-bright',
            )}
          >
            {it.value}
          </div>
        </div>
      ))}
    </div>
  );
}

// StageLights: the PLAN → BUILD → VERIFY → SHIP strip. Answers "where is
// this task?" at a glance without opening it.
export type StageState = 'done' | 'live' | 'attention' | 'failed' | 'idle';

const STAGE_LAMP: Record<StageState, { tone: LampTone; pulse: boolean; text: string }> = {
  done: { tone: 'go', pulse: false, text: 'text-ink-dim' },
  live: { tone: 'hold', pulse: true, text: 'text-hold' },
  attention: { tone: 'hold', pulse: false, text: 'text-hold' },
  failed: { tone: 'abort', pulse: false, text: 'text-danger' },
  idle: { tone: 'off', pulse: false, text: 'text-mute' },
};

export function StageLights({
  stages,
  className,
}: {
  stages: { label: string; state: StageState }[];
  className?: string;
}) {
  return (
    <div className={cn('flex gap-1.5', className)} role="img" aria-label={stagesAlt(stages)}>
      {stages.map((s) => {
        const cfg = STAGE_LAMP[s.state];
        return (
          <div
            key={s.label}
            className="flex-1 rounded-[4px] border border-line bg-surface-2 px-1 py-1.5 text-center"
          >
            <Lamp tone={cfg.tone} pulse={cfg.pulse} className="mx-auto mb-1 block size-1.5" />
            <span
              className={cn(
                'block font-mono text-[8px] font-medium tracking-[0.12em] uppercase',
                cfg.text,
              )}
            >
              {s.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function stagesAlt(stages: { label: string; state: StageState }[]): string {
  return stages.map((s) => `${s.label}: ${s.state}`).join(', ');
}

// TelemetryStrip: the page-top readout. Data-bearing pages (board, usage)
// render it from figures they already fetch — it never adds a request.
export function TelemetryStrip({
  running,
  items,
  className,
  ...props
}: {
  running: number;
  items: { label: string; value: ReactNode }[];
} & HTMLAttributes<HTMLDivElement>) {
  const live = running > 0;
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-6 gap-y-1.5 rounded-md border border-line bg-surface px-3.5 py-2 font-mono text-[10.5px] tracking-[0.08em] text-mute tabular-nums',
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          'flex items-center gap-2 font-semibold tracking-[0.14em] uppercase',
          live ? 'text-accent-bright' : 'text-mute',
        )}
      >
        <Lamp tone={live ? 'go' : 'off'} pulse={live} />
        {live ? 'Factory running' : 'Factory idle'}
      </span>
      {items.map((it) => (
        <span key={it.label} className="uppercase">
          {it.label} <span className="text-ink-dim">{it.value}</span>
        </span>
      ))}
    </div>
  );
}

// CertStrip: the sealed paper object a merged, verified feature earns.
export function CertStrip({
  sealed,
  children,
  className,
}: {
  sealed: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'cert-hatch flex items-center gap-2.5 rounded-md border px-3 py-2 font-mono text-[10.5px]',
        sealed ? 'border-line-2 text-ink-dim' : 'border-dashed border-line-2 text-mute',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'grid size-5 shrink-0 place-items-center rounded-full border text-[10px]',
          sealed ? 'border-accent-bright text-accent-bright' : 'border-line-2 text-mute',
        )}
      >
        {sealed ? '✓' : '…'}
      </span>
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}
