import {
  PatchDiff,
  WorkerPoolContextProvider,
  type DiffLineAnnotation,
  type SelectedLineRange,
  type WorkerPoolOptions,
} from '@pierre/diffs/react';
import DiffWorker from '@pierre/diffs/worker/worker.js?worker';
import type { ReactNode } from 'react';
import type { ApiCockpitComment } from '../../shared/api-types.ts';
import { ensureDiffStyles } from './diff-styles.ts';

export interface CockpitCommentMeta {
  comment?: ApiCockpitComment;
  composer?: boolean;
}

const DIFF_POOL_OPTIONS = {
  workerFactory: () => new DiffWorker(),
  poolSize: Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1)),
} satisfies WorkerPoolOptions;
const DIFF_HIGHLIGHTER_OPTIONS = { theme: 'pierre-dark' as const };

export function CockpitDiffWorkspace({ children }: { children: ReactNode }) {
  ensureDiffStyles();
  return (
    <WorkerPoolContextProvider
      poolOptions={DIFF_POOL_OPTIONS}
      highlighterOptions={DIFF_HIGHLIGHTER_OPTIONS}
    >
      {children}
    </WorkerPoolContextProvider>
  );
}

export function CockpitPatchDiff({
  patch,
  annotations,
  renderAnnotation,
  diffStyle,
  prOpen,
  onSelectionEnd,
}: {
  patch: string;
  annotations: DiffLineAnnotation<CockpitCommentMeta>[];
  renderAnnotation: (annotation: DiffLineAnnotation<CockpitCommentMeta>) => ReactNode;
  diffStyle: 'split' | 'unified';
  prOpen: boolean;
  onSelectionEnd: (range: SelectedLineRange | null) => void;
}) {
  return (
    <div className="diffs-scope rounded-none border-0">
      <PatchDiff
        patch={patch}
        lineAnnotations={annotations}
        renderAnnotation={renderAnnotation}
        options={{
          theme: 'pierre-dark',
          diffStyle,
          disableFileHeader: true,
          enableLineSelection: prOpen,
          onLineSelectionEnd: onSelectionEnd,
        }}
      />
    </div>
  );
}
