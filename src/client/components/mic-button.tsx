import { Mic, Square } from 'lucide-react';
import type { Dictation } from '../lib/dictation.ts';
import { cn } from '../lib/utils.ts';
import { Button } from './ui/button.tsx';
import { Tooltip } from './ui/tooltip.tsx';

// `compact` is the icon-only form for tight composers (the chat rail): the
// label moves into a tooltip and the accessible name.
export function MicButton({
  dictation,
  className,
  compact = false,
}: {
  dictation: Dictation;
  className?: string;
  compact?: boolean;
}) {
  if (!dictation.supported) return null;
  const label = dictation.recording ? 'Stop dictating' : 'Dictate';
  const icon = dictation.recording ? (
    <Square className="size-3.5 text-danger" aria-hidden />
  ) : (
    <Mic className="size-3.5" aria-hidden />
  );
  const toggle = () => (dictation.recording ? dictation.stop() : dictation.start());
  if (compact) {
    return (
      <Tooltip label={label}>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-pressed={dictation.recording}
          className={cn('size-7 max-sm:size-11', className)}
          onClick={toggle}
        >
          {icon}
        </Button>
      </Tooltip>
    );
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-pressed={dictation.recording}
      className={className}
      onClick={toggle}
    >
      {icon}
      {label}
    </Button>
  );
}
