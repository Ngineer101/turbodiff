import * as AccordionPrimitive from '@radix-ui/react-accordion';
import { ChevronDown } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/utils.ts';

// shadcn-style accordion on Radix primitives, themed for the dark-paper
// surface language: each item is a bordered card, the trigger row carries an
// animated chevron, and open/close heights animate via the Radix CSS vars.

export function Accordion({ className, ...props }: ComponentProps<typeof AccordionPrimitive.Root>) {
  return <AccordionPrimitive.Root className={cn('flex flex-col gap-2', className)} {...props} />;
}

export function AccordionItem({
  className,
  ...props
}: ComponentProps<typeof AccordionPrimitive.Item>) {
  return (
    <AccordionPrimitive.Item
      className={cn(
        'overflow-hidden rounded-lg border border-line bg-surface transition-colors data-[state=open]:border-line-2/80',
        className,
      )}
      {...props}
    />
  );
}

export function AccordionTrigger({
  className,
  children,
  aside,
  ...props
}: ComponentProps<typeof AccordionPrimitive.Trigger> & { aside?: ReactNode }) {
  return (
    <AccordionPrimitive.Header className="m-0 flex">
      <AccordionPrimitive.Trigger
        className={cn(
          'group flex flex-1 cursor-pointer items-center gap-2 px-3 py-2.5 text-left text-[0.85rem] text-ink-dim transition-colors hover:bg-raised/50 hover:text-ink',
          className,
        )}
        {...props}
      >
        <ChevronDown
          className="size-3.5 shrink-0 text-mute transition-transform duration-200 group-data-[state=open]:rotate-180"
          aria-hidden
        />
        <span className="min-w-0 flex-1">{children}</span>
        {aside ? <span className="ml-auto flex shrink-0 items-center gap-1.5">{aside}</span> : null}
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

export function AccordionContent({
  className,
  children,
  ...props
}: ComponentProps<typeof AccordionPrimitive.Content>) {
  return (
    <AccordionPrimitive.Content
      className="overflow-hidden data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down"
      {...props}
    >
      <div className={cn('border-t border-line px-3 py-3', className)}>{children}</div>
    </AccordionPrimitive.Content>
  );
}
