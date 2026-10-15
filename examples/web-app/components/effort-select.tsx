'use client';

import { BrainIcon } from 'lucide-react';
import {
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
} from '@/components/ai-elements/prompt-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { updateSettings, useSettings } from '@/lib/client/settings';
import { EFFORTS, type Effort } from '@/lib/providers';

interface EffortSelectProps {
  id?: string;
  className?: string;
  /** `prompt` is the compact control in the chat box; `field` is the settings form field. */
  variant?: 'field' | 'prompt';
}

/** Reasoning effort for the current provider, saved in this browser. */
export function EffortSelect({ id, className, variant = 'field' }: EffortSelectProps) {
  const settings = useSettings();
  const provider = settings.provider;
  const value = settings.efforts?.[provider] ?? 'provider-default';
  const onValueChange = (next: string) =>
    updateSettings((current) => ({ efforts: { ...current.efforts, [provider]: next as Effort } }));

  if (variant === 'prompt') {
    return (
      <PromptInputSelect value={value} onValueChange={onValueChange}>
        <PromptInputSelectTrigger id={id} size="sm" className={className} aria-label="Reasoning effort" title="Reasoning effort">
          <BrainIcon />
          <PromptInputSelectValue />
        </PromptInputSelectTrigger>
        <PromptInputSelectContent position="popper" side="top" align="start">
          {EFFORTS.map((effort) => (
            <PromptInputSelectItem key={effort.id} value={effort.id}>
              {effort.label}
            </PromptInputSelectItem>
          ))}
        </PromptInputSelectContent>
      </PromptInputSelect>
    );
  }

  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger id={id} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {EFFORTS.map((effort) => (
          <SelectItem key={effort.id} value={effort.id}>
            {effort.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
