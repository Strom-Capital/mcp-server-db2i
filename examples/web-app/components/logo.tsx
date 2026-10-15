import Image from 'next/image';
import { cn } from '@/lib/utils';

const FILES = {
  lockup: { light: '/brand/lockup-primary.svg', dark: '/brand/lockup-dark.svg', width: 184, height: 31 },
  mark: { light: '/brand/mark-primary.svg', dark: '/brand/mark-dark.svg', width: 24, height: 24 },
};

/**
 * The db2i/mcp logo from docs/assets/brand, in the ink for the current theme.
 *
 * @param variant - The mark with the wordmark, or the mark alone
 * @param className - Sets the height; the width follows
 */
export function Logo({ variant = 'lockup', className }: { variant?: keyof typeof FILES; className?: string }) {
  const file = FILES[variant];
  const shared = { width: file.width, height: file.height, unoptimized: true, priority: true };
  return (
    <>
      <Image src={file.light} alt="db2i/mcp" {...shared} className={cn('w-auto dark:hidden', className)} />
      <Image src={file.dark} alt="" aria-hidden {...shared} className={cn('hidden w-auto dark:block', className)} />
    </>
  );
}
