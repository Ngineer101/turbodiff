import { Mic, Square } from 'lucide-react';
import type { Dictation } from '../lib/dictation.ts';
import { Button } from './ui/button.tsx';

export function MicButton({ dictation, className }: { dictation: Dictation; className?: string }) {
  if (!dictation.supported) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-pressed={dictation.recording}
      className={className}
      onClick={() => (dictation.recording ? dictation.stop() : dictation.start())}
    >
      {dictation.recording ? (
        <Square className="size-3.5 text-danger" aria-hidden />
      ) : (
        <Mic className="size-3.5" aria-hidden />
      )}
      {dictation.recording ? 'Stop dictating' : 'Dictate'}
    </Button>
  );
}
