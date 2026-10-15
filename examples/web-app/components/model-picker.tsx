'use client';

import { ChevronsUpDownIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

interface ModelPickerProps {
  id?: string;
  value: string;
  models: string[];
  onChange: (model: string) => void;
}

/**
 * A searchable list of the loaded models that also takes a typed model ID, for
 * models the provider does not list or before the list is loaded.
 */
export function ModelPicker({ id, value, models, onChange }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const typed = search.trim();

  function choose(model: string) {
    onChange(model);
    setOpen(false);
    setSearch('');
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button id={id} type="button" variant="outline" role="combobox" aria-expanded={open} className="min-w-0 flex-1 justify-between font-normal">
          <span className={value ? 'truncate' : 'truncate text-muted-foreground'}>{value || 'Choose or type a model ID'}</span>
          <ChevronsUpDownIcon className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) min-w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search or type a model ID" value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>{models.length === 0 ? 'Load models, or type an ID.' : 'No model matches.'}</CommandEmpty>
            {typed && !models.includes(typed) && (
              <CommandGroup>
                <CommandItem value={`custom:${typed}`} onSelect={() => choose(typed)}>
                  Use “{typed}”
                </CommandItem>
              </CommandGroup>
            )}
            {models.length > 0 && (
              <CommandGroup heading={models.length === 1 ? '1 model' : `${models.length} models`}>
                {models.map((model) => (
                  <CommandItem key={model} value={model} data-checked={model === value} onSelect={() => choose(model)}>
                    <span className="truncate">{model}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
