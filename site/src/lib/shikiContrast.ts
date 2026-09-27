import type { ShikiTransformer } from 'shiki';

/**
 * Vitesse's token colors are soft, and several fall below WCAG AA (4.5:1) on the
 * site's backgrounds. This darkens light-theme colors and lightens dark-theme
 * colors just enough to reach AA against the page background, keeping the hue.
 * Backgrounds come from styles/tokens.css (`--bg`, the darker of bg and surface).
 * Colors with an alpha channel (Vitesse fades quotes and punctuation) are made opaque first.
 */
const TARGET = 4.6;
const BACKGROUND = { light: '#f3f1eb', dark: '#181918' } as const;

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Mix `hex` toward black (light theme) or white (dark theme) until it reaches TARGET. */
function adjust(hex: string, theme: keyof typeof BACKGROUND): string {
  const bg = BACKGROUND[theme];
  if (contrast(hex, bg) >= TARGET) return hex;
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const toward = theme === 'light' ? 0 : 255;
  for (let t = 0.05; t <= 1; t += 0.05) {
    const out = '#' + rgb.map((c) => Math.round(c + (toward - c) * t).toString(16).padStart(2, '0')).join('');
    if (contrast(out, bg) >= TARGET) return out;
  }
  return theme === 'light' ? '#000000' : '#ffffff';
}

const TOKEN_COLOR = /--shiki-(light|dark):(#[0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?\b/g;

/**
 * Shiki transformer for the dual `vitesse-light` / `vitesse-dark` output (defaultColor: false).
 * Uses the per-token `span` hook, which both `<Code>` and the Markdown pipeline run.
 */
export const shikiContrast: ShikiTransformer = {
  name: 'site:contrast',
  span(node) {
    const style = node.properties.style;
    if (typeof style !== 'string') return;
    node.properties.style = style.replace(TOKEN_COLOR, (_, theme: 'light' | 'dark', hex: string) => `--shiki-${theme}:${adjust(hex, theme)}`);
  },
};
