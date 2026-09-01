import { useState, type ReactNode } from 'react';
import { Button, type ButtonProps } from './ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog.tsx';

// Replaces v1's window.confirm() for destructive/irreversible actions.
export function ConfirmButton({
  title,
  description,
  confirmLabel,
  onConfirm,
  busy,
  children,
  ...buttonProps
}: {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  busy?: boolean;
  children: ReactNode;
} & Omit<ButtonProps, 'onClick' | 'title'>) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* type="button" is load-bearing: this trigger often lives inside a
          <form> (e.g. the entity edit forms), where a button with no explicit
          type defaults to submit — clicking Delete would submit the form. */}
      <Button {...buttonProps} type="button" loading={busy} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <DialogContent>
        <DialogTitle className="text-base font-medium">{title}</DialogTitle>
        <DialogDescription className="mt-2 text-[0.85rem] text-mute">
          {description}
        </DialogDescription>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={buttonProps.variant === 'danger' ? 'danger' : 'default'}
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
