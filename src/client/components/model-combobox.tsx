import { Check, ChevronsUpDown } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import type { ApiModelOption } from '../../shared/api-types.ts';
import { cn } from '../lib/utils.ts';
import { Button } from './ui/button.tsx';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './ui/command.tsx';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.tsx';

const PROVIDER_LABELS = new Map([
  ['alibaba', 'Alibaba'],
  ['anthropic', 'Anthropic'],
  ['deepseek', 'DeepSeek'],
  ['google', 'Google'],
  ['minimax', 'MiniMax'],
  ['moonshotai', 'Moonshot AI'],
  ['openai', 'OpenAI'],
  ['thinkingmachines', 'Thinking Machines'],
  ['xai', 'xAI'],
]);

export interface ModelOptionGroup {
  provider: string;
  options: ApiModelOption[];
}

function modelCatalogId(id: string): string {
  return id.startsWith('cloudflare/') ? id.slice('cloudflare/'.length) : id;
}

export function modelProvider(id: string): string {
  const catalogId = modelCatalogId(id);
  if (catalogId.startsWith('@cf/')) return 'Workers AI';
  const provider = catalogId.split('/')[0] ?? catalogId;
  return PROVIDER_LABELS.get(provider) ?? provider;
}

export function groupModelOptions(
  options: readonly ApiModelOption[],
  query: string,
): ModelOptionGroup[] {
  const needle = query.trim().toLocaleLowerCase();
  const groups = new Map<string, ApiModelOption[]>();
  for (const option of options) {
    const provider = modelProvider(option.id);
    const searchable = `${option.label} ${option.id} ${provider}`.toLocaleLowerCase();
    if (needle && !searchable.includes(needle)) continue;
    const group = groups.get(provider);
    if (group) group.push(option);
    else groups.set(provider, [option]);
  }
  return Array.from(groups, ([provider, groupedOptions]) => ({
    provider,
    options: groupedOptions,
  }));
}

export function ModelCombobox({
  options,
  value,
  onValueChange,
  defaultLabel,
  placeholder = 'Select a model…',
  searchPlaceholder = 'Search models…',
  disabled,
  required,
  id,
  className,
  ariaLabel = 'Model',
}: {
  options: readonly ApiModelOption[];
  value: string;
  onValueChange: (value: string) => void;
  defaultLabel?: string;
  placeholder?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  className?: string;
  ariaLabel?: string;
}) {
  const generatedId = useId();
  const listId = `${generatedId}-list`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = options.find((option) => option.id === value);
  const groups = useMemo(() => groupModelOptions(options, query), [options, query]);
  const selectedProvider = selected ? modelProvider(selected.id) : null;

  const close = () => {
    setOpen(false);
    setQuery('');
  };
  const select = (next: string) => {
    onValueChange(next);
    close();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="secondary"
          role="combobox"
          aria-label={ariaLabel}
          aria-controls={listId}
          aria-expanded={open}
          aria-required={required}
          disabled={disabled}
          className={cn(
            'min-h-10 w-full justify-between gap-3 overflow-hidden px-3 py-2 text-left text-base font-normal sm:min-h-0 sm:px-2.5 sm:py-1.5 sm:text-sm',
            className,
          )}
        >
          <span
            className={cn('min-w-0 flex-1 truncate', !selected && !defaultLabel && 'text-mute')}
          >
            {selected?.label ?? defaultLabel ?? placeholder}
          </span>
          {selectedProvider ? (
            <span className="hidden shrink-0 font-mono text-[10px] tracking-wide text-mute uppercase sm:inline">
              {selectedProvider}
            </span>
          ) : null}
          <ChevronsUpDown className="size-3.5 shrink-0 text-mute" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[min(20rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] overflow-hidden p-0">
        <Command shouldFilter={false} loop>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={searchPlaceholder}
            aria-label="Search models"
          />
          <CommandList id={listId}>
            <CommandEmpty>No matching models.</CommandEmpty>
            {defaultLabel &&
            (!query || 'default deployment'.includes(query.trim().toLowerCase())) ? (
              <CommandGroup heading="Selection">
                <CommandItem value={`default ${defaultLabel}`} onSelect={() => select('')}>
                  <Check
                    className={cn('mr-2 size-3.5', value ? 'opacity-0' : 'opacity-100')}
                    aria-hidden
                  />
                  <span className="truncate">{defaultLabel}</span>
                </CommandItem>
              </CommandGroup>
            ) : null}
            {groups.map((group) => (
              <CommandGroup key={group.provider} heading={group.provider}>
                {group.options.map((option) => (
                  <CommandItem
                    key={option.id}
                    value={`${option.label} ${option.id} ${group.provider}`}
                    onSelect={() => select(option.id)}
                    className="gap-2"
                  >
                    <Check
                      className={cn(
                        'size-3.5 shrink-0',
                        value === option.id ? 'opacity-100' : 'opacity-0',
                      )}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{option.label}</span>
                      <span className="block truncate font-mono text-[10px] text-mute">
                        {modelCatalogId(option.id)}
                      </span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
