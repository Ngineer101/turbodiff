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
      <Button {...buttonProps} loading={busy} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <DialogContent>
        <DialogTitle className="text-base font-medium">{title}</DialogTitle>
        <DialogDescription className="mt-2 text-[0.85rem] text-mute">
          {description}
        </DialogDescription>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
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
