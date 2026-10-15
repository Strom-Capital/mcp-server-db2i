'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { forgetKey, updateSettings, useSettings } from '@/lib/client/settings';
import { MODEL_KEY_HEADER, PROVIDERS, type ProviderId } from '@/lib/providers';
import { useAppState } from './app-state';
import { EffortSelect } from './effort-select';
import { ModelPicker } from './model-picker';

/** Model provider, API key and model, kept in this browser only. The app's own keys are used when no key is entered. */
export function SettingsDialog() {
  const { settingsOpen, setSettingsOpen, session } = useAppState();
  const settings = useSettings();
  const [loaded, setLoaded] = useState<{ provider?: ProviderId; models: string[]; error?: string }>({ models: [] });
  const [loading, setLoading] = useState(false);

  const provider = settings.provider;
  const models = loaded.provider === provider ? loaded.models : [];
  const loadError = loaded.provider === provider ? loaded.error : undefined;
  const entry = PROVIDERS.find((item) => item.id === provider) ?? PROVIDERS[0];
  const key = settings.keys[provider] ?? '';
  const model = settings.models[provider] ?? '';
  const baseUrls = session.customModelBaseUrls;
  const serverKey = session.serverKeys.includes(provider);
  const keyNeeded = entry.needsKey && !serverKey;

  async function loadModels() {
    setLoading(true);
    setLoaded({ provider, models: [] });
    try {
      const response = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [MODEL_KEY_HEADER]: key },
        body: JSON.stringify({ provider, baseUrl: settings.baseUrl }),
      });
      const body = (await response.json()) as { models?: string[]; error?: string };
      if (!response.ok) {
        throw new Error(body.error ?? 'Could not list models.');
      }
      setLoaded({ provider, models: body.models ?? [] });
      if (!model && body.models?.[0]) {
        updateSettings((current) => ({ models: { ...current.models, [provider]: body.models?.[0] } }));
      }
    } catch (error) {
      setLoaded({ provider, models: [], error: error instanceof Error ? error.message : 'Could not list models.' });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setSettingsOpen(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>Model settings</DialogTitle>
            <DialogDescription>
              A key you enter stays in this browser. It is sent only with your own chat requests to this app, which passes it to
              the provider and does not store or log it.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Label htmlFor="provider">Provider</Label>
            <Select value={provider} onValueChange={(value) => updateSettings({ provider: value as ProviderId })}>
              <SelectTrigger id="provider" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDERS.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {provider === 'openai-compatible' && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="base-url">Base URL</Label>
              <Select value={settings.baseUrl ?? baseUrls[0] ?? ''} onValueChange={(value) => updateSettings({ baseUrl: value })}>
                <SelectTrigger id="base-url" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {baseUrls.map((url) => (
                    <SelectItem key={url} value={url}>
                      {url}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-muted-foreground text-xs">CUSTOM_MODEL_BASE_URLS in the environment of this app lists the allowed addresses.</span>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="api-key">API key{keyNeeded ? '' : ' (optional)'}</Label>
            <div className="flex gap-2">
              <Input
                id="api-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={entry.keyHint}
                value={key}
                onChange={(event) =>
                  updateSettings((current) => ({ keys: { ...current.keys, [provider]: event.target.value.trim() } }))
                }
              />
              {key && (
                <Button type="button" variant="outline" onClick={() => forgetKey(provider)}>
                  Forget
                </Button>
              )}
            </div>
            {serverKey && (
              <span className="text-muted-foreground text-xs">
                This app has its own key for {entry.label}, so you can leave this empty. A key you enter here is used instead.
              </span>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="model">Model</Label>
            <div className="flex gap-2">
              <ModelPicker
                id="model"
                value={model}
                models={models}
                onChange={(next) => updateSettings((current) => ({ models: { ...current.models, [provider]: next } }))}
              />
              <Button type="button" variant="outline" disabled={loading || (keyNeeded && !key)} onClick={() => void loadModels()}>
                {loading ? 'Loading' : 'Load models'}
              </Button>
            </div>
            {loadError && <span className="text-destructive text-xs">{loadError}</span>}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="effort">Reasoning effort</Label>
            <EffortSelect id="effort" className="w-full" />
            <span className="text-muted-foreground text-xs">
              How long the model thinks before it answers. Higher is slower and costs more. Models without reasoning ignore it.
            </span>
          </div>

          <DialogFooter>
            <Button type="submit">Done</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
