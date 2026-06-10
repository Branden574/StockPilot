'use client';

import { CheckCircle2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { createSupportTicketAction } from '@/server/actions/support-tickets';

const CATEGORIES: Array<{ value: string; label: string }> = [
  { value: 'bug', label: "Something's broken" },
  { value: 'account', label: 'Account / sign-in' },
  { value: 'billing', label: 'Billing' },
  { value: 'feature', label: 'Feature request' },
  { value: 'other', label: 'Other' },
];
const PRIORITIES: Array<{ value: string; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent — blocking my team' },
];

const selectClass =
  'border-border bg-background focus-visible:ring-ring h-10 w-full rounded-md border px-3 text-sm focus-visible:outline-none focus-visible:ring-2';

export function SupportForm() {
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [category, setCategory] = React.useState('bug');
  const [priority, setPriority] = React.useState('normal');
  const [subject, setSubject] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [company, setCompany] = React.useState(''); // honeypot

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await createSupportTicketAction({
      name: name.trim() || undefined,
      email: email.trim(),
      category: category as never,
      priority: priority as never,
      subject: subject.trim(),
      message: message.trim(),
      pageUrl: typeof document !== 'undefined' ? document.referrer || undefined : undefined,
      company: company || undefined,
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <div className="border-border bg-card rounded-xl border p-8 text-center">
        <CheckCircle2 className="text-foreground mx-auto h-8 w-8" strokeWidth={1.6} />
        <h2 className="mt-3 text-lg font-semibold">Ticket received</h2>
        <p className="text-muted-foreground mx-auto mt-1.5 max-w-sm text-sm leading-relaxed">
          Thanks — we&apos;ve logged your ticket and emailed our team. We&apos;ll reply to the email
          you provided, usually within 1–2 business days.
        </p>
        <Button variant="outline" className="mt-5" onClick={() => {
          setDone(false);
          setSubject('');
          setMessage('');
        }}>
          Submit another
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="sup-name">Name</Label>
          <Input id="sup-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="name" />
        </div>
        <div>
          <Label htmlFor="sup-email">
            Email <span className="text-destructive">*</span>
          </Label>
          <Input id="sup-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} autoComplete="email" placeholder="you@company.com" />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="sup-category">What&apos;s this about?</Label>
          <select id="sup-category" className={selectClass} value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="sup-priority">Priority</Label>
          <select id="sup-priority" className={selectClass} value={priority} onChange={(e) => setPriority(e.target.value)}>
            {PRIORITIES.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <Label htmlFor="sup-subject">
          Subject <span className="text-destructive">*</span>
        </Label>
        <Input id="sup-subject" required value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} placeholder="Short summary" />
      </div>

      <div>
        <Label htmlFor="sup-message">
          Details <span className="text-destructive">*</span>
        </Label>
        <Textarea id="sup-message" required value={message} onChange={(e) => setMessage(e.target.value)} rows={6} maxLength={8000} placeholder="What happened? What did you expect? If it's broken, what were you doing when it broke?" />
      </div>

      {/* Honeypot — visually hidden, off-screen, not announced. Bots fill it. */}
      <div aria-hidden className="pointer-events-none absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="sup-company">Company</label>
        <input id="sup-company" tabIndex={-1} autoComplete="off" value={company} onChange={(e) => setCompany(e.target.value)} />
      </div>

      <div className="flex items-center justify-between pt-1">
        <p className="text-muted-foreground text-xs">We&apos;ll only use your email to reply.</p>
        <Button type="submit" disabled={busy}>
          {busy ? 'Sending…' : 'Send ticket'}
        </Button>
      </div>
    </form>
  );
}
