import type { ReactNode } from 'react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface AuthCardProps {
  title: string;
  description?: string;
  footer?: ReactNode;
  children: ReactNode;
}

export function AuthCard({ title, description, footer, children }: AuthCardProps) {
  return (
    <Card className="border-border/60 shadow-xl backdrop-blur supports-[backdrop-filter]:bg-card/80">
      <CardHeader className="space-y-2 text-center">
        <CardTitle className="text-2xl tracking-tight">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
      {footer && (
        <div className="border-t bg-muted/30 px-6 py-4 text-center text-sm text-muted-foreground">
          {footer}
        </div>
      )}
    </Card>
  );
}
