import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { cn } from '../lib/utils.ts';

// The real renderer — loaded lazily via markdown.tsx so the remark/rehype +
// highlight.js stack (~100 kB gz) stays out of the entry bundle. Import
// markdown.tsx, not this file.
export default function MarkdownImpl({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={cn('markdown-body', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // detect: fenced blocks without a language tag still get highlighted
        // (agents don't always tag their fences).
        rehypePlugins={[[rehypeHighlight, { detect: true }]]}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
