import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils.ts';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  className,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 animate-overlay-in bg-black/60 backdrop-blur-[3px] motion-reduce:animate-none" />
      <DialogPrimitive.Content
        className={cn(
          'fixed top-1/2 left-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 animate-dialog-in rounded-xl border border-line-2 bg-surface p-5 shadow-sticker-xl outline-none motion-reduce:animate-none',
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          className="absolute top-3 right-3 cursor-pointer rounded-md p-1.5 text-mute transition-colors hover:bg-raised hover:text-ink"
          aria-label="Close"
        >
          <X className="size-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

// Bottom sheet: the same Radix dialog, docked to the viewport floor. Used
// where a side rail has no room (the cockpit chat below lg). Content lays
// out as a column so a header, a scrolling body, and a pinned footer fit.
export function SheetContent({
  className,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 animate-overlay-in bg-black/60 backdrop-blur-[3px] motion-reduce:animate-none" />
      <DialogPrimitive.Content
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 flex h-[88dvh] flex-col animate-sheet-in rounded-t-xl border-t border-line-2 bg-surface-2 pb-[env(safe-area-inset-bottom)] outline-none motion-reduce:animate-none',
          className,
        )}
        {...props}
      >
        <div className="flex shrink-0 justify-center pt-2" aria-hidden>
          <span className="h-1 w-9 rounded-full bg-line-2" />
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
