import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { IconMark } from '@/components/ui/icon-mark';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-6 text-center">
      <IconMark />
      <div>
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">404</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Page not found</h1>
        <p className="mt-2 text-muted-foreground">The page you're looking for doesn't exist or moved.</p>
      </div>
      <Button asChild variant="gradient">
        <Link href="/">Back to home</Link>
      </Button>
    </div>
  );
}
