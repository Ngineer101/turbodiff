import { lazy, Suspense } from 'react';
import { cn } from '../lib/utils.ts';

// Lazy facade over markdown-impl.tsx: the remark/rehype + highlight.js stack
// is a large dependency that no first paint needs — while its chunk loads,
// the raw markdown text stands in (same box, no layout jump).
const MarkdownImpl = lazy(() => import('./markdown-impl.tsx'));

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <Suspense
      fallback={
        <div className={cn('markdown-body whitespace-pre-wrap', className)}>{children}</div>
      }
    >
      <MarkdownImpl className={className}>{children}</MarkdownImpl>
    </Suspense>
  );
}
