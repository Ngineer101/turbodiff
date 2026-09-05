import { ArrowUpRight } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  ApiFeatureExplanation,
  ExplanationBlock,
  ExplanationDocument,
  ExplanationRef,
  ExplanationSequenceBlock,
  ExplanationSketchBlock,
} from '../../shared/api-types.ts';
import { ago } from '../lib/format.ts';
import { cn } from '../lib/utils.ts';
import { Lamp } from './identity.tsx';
import { Button } from './ui/button.tsx';

// The Explain tab of the cockpit review workspace (docs/explain-tab.md): a
// show-me document beside the raw diff. One
// sentence per block, then the smallest code-shape sketch that makes the
// point, each with jump refs back into the Diff tab. Mirrors the diff
// layout — a sticky outline where the file tree sits, the document where
// the patches sit — so switching tabs keeps the reader's bearings.

const KIND_LABEL = {
  summary: 'What changed',
  call_tree: 'Call tree',
  pseudocode: 'Pseudocode',
  file_tree: 'Files',
  component_tree: 'Components',
  sequence: 'Sequence',
} satisfies Record<ExplanationBlock['kind'], string>;

function blockTitle(block: ExplanationBlock): string {
  return block.kind === 'summary' ? KIND_LABEL.summary : block.title;
}

function refLabel(ref: ExplanationRef): string {
  const base = ref.path.slice(ref.path.lastIndexOf('/') + 1);
  if (ref.start === undefined) return base;
  return ref.end !== undefined && ref.end !== ref.start
    ? `${base}:${ref.start}–${ref.end}`
    : `${base}:${ref.start}`;
}

function JumpRef({ refItem, onJump }: { refItem: ExplanationRef; onJump: JumpHandler }) {
  return (
    <button
      type="button"
      onClick={() => onJump(refItem.path, refItem.start)}
      title={`Open ${refItem.path} in the Diff tab`}
      className="inline-flex cursor-pointer items-center gap-0.5 border-b border-accent/40 font-mono text-[11px] leading-4 text-accent hover:border-accent hover:text-accent-bright"
    >
      {refLabel(refItem)}
      <ArrowUpRight className="size-3" aria-hidden />
    </button>
  );
}

export type JumpHandler = (path: string, line?: number) => void;

function BlockHeader({
  index,
  block,
  onJump,
}: {
  index: number;
  block: ExplanationBlock;
  onJump: JumpHandler;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <div className="flex items-baseline gap-2.5">
        <span className="font-mono text-[11px] text-accent tabular-nums">
          {String(index + 1).padStart(2, '0')}
        </span>
        <span className="font-mono text-[10px] font-medium tracking-[0.16em] text-mute uppercase">
          {KIND_LABEL[block.kind]}
          {block.kind !== 'summary' ? ` · ${block.title}` : null}
        </span>
      </div>
      {block.kind !== 'summary' && block.refs.length > 0 ? (
        <span className="flex flex-wrap items-center gap-3">
          {block.refs.map((ref, i) => (
            <JumpRef key={`${ref.path}:${ref.start ?? ''}:${i}`} refItem={ref} onJump={onJump} />
          ))}
        </span>
      ) : null}
    </div>
  );
}

// Text-shaped sketches: one monospace column, diff-coloured per line.
function Sketch({ block }: { block: ExplanationSketchBlock }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-line bg-surface-2 px-3.5 py-3 font-mono text-xs leading-5">
      {block.lines.map((line, i) => (
        <div
          key={i}
          className={cn(
            line.change === '+' && 'text-go-bright',
            line.change === '-' && 'text-danger',
            !line.change && 'text-ink-dim',
          )}
        >
          {line.change ?? ' '} {line.text}
        </div>
      ))}
    </pre>
  );
}

// Sequence diagrams are drawn here from the structured block rather than
// rendered from a diagram language: no extra dependency, and the result
// uses the same tokens as the rest of the cockpit.
const SEQ = {
  column: 190,
  padX: 24,
  boxW: 96,
  boxH: 24,
  top: 8,
  firstRow: 64,
  row: 32,
  loopPad: 14,
  bottom: 16,
};

function SequenceDiagram({ block }: { block: ExplanationSequenceBlock }) {
  const xOf = new Map(
    block.participants.map((p, i) => [p, SEQ.padX + SEQ.boxW / 2 + i * SEQ.column]),
  );
  const width = SEQ.padX * 2 + SEQ.boxW + (block.participants.length - 1) * SEQ.column;
  const loop = block.loop;
  // Rows shift down by one loop pad inside a bracket so the label has room.
  const rowY = (i: number) =>
    SEQ.firstRow + i * SEQ.row + (loop && i >= loop.from ? SEQ.loopPad : 0);
  const height = rowY(block.messages.length - 1) + SEQ.row / 2 + SEQ.bottom;
  const loopBox = loop
    ? (() => {
        const xs = block.messages
          .slice(loop.from, loop.to + 1)
          .flatMap((m) => [xOf.get(m.from) ?? 0, xOf.get(m.to) ?? 0]);
        const x1 = Math.min(...xs) - 36;
        const x2 = Math.max(...xs) + 36;
        return {
          x: x1,
          y: rowY(loop.from) - SEQ.loopPad - 10,
          w: x2 - x1,
          h: rowY(loop.to) - rowY(loop.from) + SEQ.loopPad + 24,
        };
      })()
    : null;

  return (
    <div className="overflow-x-auto rounded-md border border-line bg-surface-2 px-3 py-3">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        className="block max-w-full font-mono text-[11px]"
        role="img"
        aria-label={`${block.title}: ${block.messages.map((m) => `${m.from} to ${m.to} ${m.label}`).join('; ')}`}
      >
        {block.participants.map((p) => {
          const x = xOf.get(p) ?? 0;
          return (
            <g key={p}>
              <rect
                x={x - SEQ.boxW / 2}
                y={SEQ.top}
                width={SEQ.boxW}
                height={SEQ.boxH}
                rx="4"
                className="fill-raised stroke-line-2"
              />
              <text x={x} y={SEQ.top + 16} textAnchor="middle" className="fill-ink">
                {p}
              </text>
              <line
                x1={x}
                y1={SEQ.top + SEQ.boxH}
                x2={x}
                y2={height - 4}
                className="stroke-line-2"
                strokeDasharray="3 3"
              />
            </g>
          );
        })}
        {loopBox ? (
          <g>
            <rect
              x={loopBox.x}
              y={loopBox.y}
              width={loopBox.w}
              height={loopBox.h}
              rx="4"
              fill="none"
              className="stroke-accent"
              strokeDasharray="4 3"
            />
            <text x={loopBox.x + 8} y={loopBox.y + 13} className="fill-accent">
              {loop?.label}
            </text>
          </g>
        ) : null}
        {block.messages.map((m, i) => {
          const y = rowY(i);
          const x1 = xOf.get(m.from) ?? 0;
          const x2 = xOf.get(m.to) ?? 0;
          const stroke =
            m.style === 'error'
              ? 'stroke-danger'
              : m.style === 'reply'
                ? 'stroke-mute'
                : 'stroke-ink-dim';
          const fill =
            m.style === 'error'
              ? 'fill-danger'
              : m.style === 'reply'
                ? 'fill-mute'
                : 'fill-ink-dim';
          const dash = m.style === 'call' ? undefined : '4 2';
          if (x1 === x2) {
            // Self message: a small hook off the lifeline, arrow pointing back.
            return (
              <g key={i}>
                <path
                  d={`M${x1} ${y - 8} H${x1 + 28} V${y + 6} H${x1 + 4}`}
                  fill="none"
                  className={stroke}
                  strokeDasharray={dash}
                />
                <path
                  d={`M${x1 + 10} ${y + 2} L${x1 + 4} ${y + 6} L${x1 + 10} ${y + 10}`}
                  fill="none"
                  className={stroke}
                />
                <text x={x1 + 34} y={y + 2} className={fill}>
                  {m.label}
                </text>
              </g>
            );
          }
          const dir = x2 > x1 ? 1 : -1;
          const tip = x2 - dir * 4;
          return (
            <g key={i}>
              <line x1={x1} y1={y} x2={tip} y2={y} className={stroke} strokeDasharray={dash} />
              <path
                d={`M${tip - dir * 6} ${y - 4} L${tip} ${y} L${tip - dir * 6} ${y + 4}`}
                fill="none"
                className={stroke}
              />
              <text x={(x1 + x2) / 2} y={y - 6} textAnchor="middle" className={fill}>
                {m.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Block({
  index,
  block,
  onJump,
  sectionRef,
}: {
  index: number;
  block: ExplanationBlock;
  onJump: JumpHandler;
  sectionRef: (el: HTMLElement | null) => void;
}) {
  return (
    <section ref={sectionRef} data-block={index} className="flex scroll-mt-4 flex-col gap-2">
      <BlockHeader index={index} block={block} onJump={onJump} />
      {block.kind === 'summary' ? (
        <p className="max-w-[60ch] text-[0.9rem] leading-relaxed text-ink">{block.text}</p>
      ) : (
        <>
          <p className="max-w-[60ch] text-[0.85rem] leading-snug text-ink-dim">{block.text}</p>
          {block.kind === 'sequence' ? <SequenceDiagram block={block} /> : <Sketch block={block} />}
        </>
      )}
    </section>
  );
}

function Outline({
  document,
  active,
  onSelect,
}: {
  document: ExplanationDocument;
  active: number;
  onSelect: (index: number) => void;
}) {
  return (
    <nav aria-label="Explanation sections" className="flex flex-col gap-px">
      {document.blocks.map((block, i) => (
        <button
          key={i}
          type="button"
          onClick={() => onSelect(i)}
          className={cn(
            'flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1 text-left text-xs transition-colors',
            i === active
              ? 'bg-accent/10 text-accent'
              : 'text-ink-dim hover:bg-raised/60 hover:text-ink',
          )}
        >
          <span
            className={cn(
              'w-4 shrink-0 font-mono text-[11px] tabular-nums',
              i !== active && 'text-mute',
            )}
          >
            {String(i + 1).padStart(2, '0')}
          </span>
          <span className="truncate">{blockTitle(block)}</span>
        </button>
      ))}
    </nav>
  );
}

function DocumentPanel({
  document,
  header,
  banner,
  onJump,
  sectionRef,
}: {
  document: ExplanationDocument;
  header: ReactNode;
  banner?: ReactNode;
  onJump: JumpHandler;
  sectionRef: (index: number, el: HTMLElement | null) => void;
}) {
  return (
    <div className="overflow-clip rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3.5 py-2.5 text-xs">
        {header}
      </div>
      {banner}
      <div className="flex flex-col gap-6 px-4 py-4 sm:px-5 sm:py-5">
        {document.blocks.map((block, i) => (
          <Block
            key={i}
            index={i}
            block={block}
            onJump={onJump}
            sectionRef={(el) => sectionRef(i, el)}
          />
        ))}
      </div>
    </div>
  );
}

function WritingPanel({ model }: { model: string | null }) {
  return (
    <div
      className="overflow-clip rounded-lg border border-line bg-surface"
      role="status"
      aria-label="Writing explanation"
    >
      <div className="flex items-center justify-between gap-2 border-b border-line px-3.5 py-2.5 text-xs">
        <span className="flex items-center gap-2 font-mono font-medium">
          <Lamp tone="hold" pulse />
          Writing explanation
        </span>
        <span className="font-mono text-mute">{model ?? 'reading the diff'}</span>
      </div>
      <div className="flex flex-col gap-3 px-5 py-5">
        <div className="h-2.5 w-44 animate-pulse rounded bg-raised" />
        <div className="h-2.5 w-[28rem] max-w-full animate-pulse rounded bg-raised" />
        <div className="h-24 max-w-[34rem] animate-pulse rounded-md border border-line bg-surface-2" />
      </div>
    </div>
  );
}

export function CockpitExplain({
  title,
  version,
  fileCount,
  explanation,
  loading,
  generating,
  onGenerate,
  onJump,
}: {
  title: string;
  version: string | null;
  fileCount: number;
  explanation: ApiFeatureExplanation | undefined;
  loading: boolean;
  generating: boolean;
  onGenerate: () => void;
  onJump: JumpHandler;
}) {
  // On demand: the first open of the tab for a head with no row asks for
  // one. Once per version, so a failed dispatch shows its error instead of
  // looping.
  const requested = useRef(new Set<string>());
  useEffect(() => {
    if (!version || explanation?.status !== 'none' || requested.current.has(version)) return;
    requested.current.add(version);
    onGenerate();
  }, [version, explanation?.status, onGenerate]);

  const sectionEls = useRef(new Map<number, HTMLElement>());
  const [active, setActive] = useState(0);
  const document =
    explanation?.status === 'ready'
      ? explanation.document
      : (explanation?.previous?.document ?? null);

  // Scroll spy for the outline, like the diff's file tree.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const top = visible[0]?.target.getAttribute('data-block');
        if (top !== null && top !== undefined) setActive(Number(top));
      },
      { rootMargin: '0px 0px -70% 0px' },
    );
    for (const el of sectionEls.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [document]);

  const jumpToBlock = (index: number) => {
    setActive(index);
    sectionEls.current.get(index)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const registerSection = (index: number, el: HTMLElement | null) => {
    if (el) sectionEls.current.set(index, el);
    else sectionEls.current.delete(index);
  };

  const header = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate font-mono font-medium">{title}</span>
        <span className="shrink-0 rounded border border-line-2 px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-[0.16em] text-mute uppercase">
          Explain
        </span>
      </span>
      <span className="shrink-0 font-mono text-mute tabular-nums">
        {fileCount} file{fileCount === 1 ? '' : 's'}
      </span>
    </>
  );

  let panel: ReactNode;
  if (!version) {
    panel = (
      <p className="rounded-lg border border-line bg-surface px-4 py-6 text-sm text-mute">
        There is no change to explain until a pull request exists.
      </p>
    );
  } else if (loading && !explanation) {
    panel = <div className="h-64 animate-pulse rounded-lg border border-line bg-surface" />;
  } else if (explanation?.status === 'failed' && !document) {
    panel = (
      <div className="rounded-lg border border-line bg-surface px-4 py-5">
        <p className="text-sm text-danger">The explanation could not be written.</p>
        {explanation.error ? (
          <p className="mt-1 font-mono text-xs break-words text-mute">{explanation.error}</p>
        ) : null}
        <Button
          variant="secondary"
          size="sm"
          className="mt-3"
          onClick={onGenerate}
          loading={generating}
        >
          Try again
        </Button>
      </div>
    );
  } else if (document && explanation) {
    const stale = explanation.status !== 'ready';
    const banner = stale ? (
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-warn/40 bg-warn/10 px-3.5 py-2 text-xs">
        <span className="flex items-center gap-2 text-ink-dim">
          <Lamp tone="hold" pulse={explanation.status === 'running'} />
          {explanation.status === 'running'
            ? `Written for ${explanation.previous?.version.slice(0, 7)}. The branch moved to ${version.slice(0, 7)} — a rewrite is in progress; jump refs may have moved.`
            : `Written for ${explanation.previous?.version.slice(0, 7)}. The branch moved to ${version.slice(0, 7)} — jump refs may have moved.`}
        </span>
        {explanation.status !== 'running' ? (
          <button
            type="button"
            onClick={onGenerate}
            disabled={generating}
            className="cursor-pointer font-mono text-[11px] font-semibold tracking-[0.14em] text-accent uppercase hover:text-accent-bright disabled:opacity-60"
          >
            Rewrite
          </button>
        ) : null}
      </div>
    ) : undefined;
    panel = (
      <DocumentPanel
        document={document}
        header={header}
        banner={banner}
        onJump={onJump}
        sectionRef={registerSection}
      />
    );
  } else {
    panel = <WritingPanel model={explanation?.model ?? null} />;
  }

  return (
    <div className="mt-3 lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start lg:gap-6">
      <aside className="hidden lg:sticky lg:top-4 lg:block lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto lg:pb-2">
        <div className="mb-2 flex items-baseline justify-between gap-2 px-1.5">
          <span className="font-mono text-[10px] font-medium tracking-[0.16em] text-mute uppercase">
            Sections
          </span>
          {document ? (
            <span className="text-xs text-mute tabular-nums">{document.blocks.length}</span>
          ) : null}
        </div>
        {document ? (
          <Outline document={document} active={active} onSelect={jumpToBlock} />
        ) : (
          <p className="px-2 text-xs text-mute">Sections appear as the document is written.</p>
        )}
        <p className="mt-4 px-2 text-[11px] leading-4 text-mute">
          Every block links back to the lines it describes. Open Diff to comment.
        </p>
      </aside>
      <div className="min-w-0">{panel}</div>
    </div>
  );
}

// The tab-bar aside for the Explain tab: provenance and Regenerate.
export function ExplainTabAside({
  explanation,
  generating,
  onGenerate,
}: {
  explanation: ApiFeatureExplanation | undefined;
  generating: boolean;
  onGenerate: () => void;
}) {
  const provenance =
    explanation?.status === 'ready' && explanation.version
      ? `from ${explanation.version.slice(0, 7)} · ${ago(explanation.completed_at ?? explanation.created_at ?? '')}`
      : explanation?.status === 'running'
        ? `writing${explanation.model ? ` · ${explanation.model.split('/').at(-1)}` : ''}`
        : null;
  return (
    <span className="flex flex-wrap items-center gap-2">
      {provenance ? <span className="font-mono text-[11px] text-mute">{provenance}</span> : null}
      <Button
        variant="secondary"
        size="sm"
        onClick={onGenerate}
        loading={generating}
        disabled={explanation?.status === 'running' || !explanation?.version}
      >
        Regenerate
      </Button>
    </span>
  );
}
