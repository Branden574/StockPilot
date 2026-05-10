'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { submitShipmentSignatureAction } from '@/server/actions/shipment-signature';

import {
  SignaturePad,
  type SignaturePadHandle,
} from './signature-pad';

// Slimmer form schema — the data URL is supplied imperatively from the
// signature pad, not via a registered RHF field. Mirrors the server schema
// for the user-typed pieces only.
const formSchema = z.object({
  signedByName: z
    .string()
    .trim()
    .min(1, 'Please type your name')
    .max(120, 'Name is too long'),
  email: z.string().trim().toLowerCase().email('Enter a valid email').max(254),
  notes: z.string().max(2000).optional(),
});
type FormValues = z.infer<typeof formSchema>;

interface SignatureFormProps {
  token: string;
  defaultEmail?: string | null;
  onSigned: (info: { signedByName: string; email: string }) => void;
}

export function SignatureForm({ token, defaultEmail, onSigned }: SignatureFormProps) {
  const padRef = React.useRef<SignaturePadHandle>(null);
  const [padEmpty, setPadEmpty] = React.useState(true);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      signedByName: '',
      email: defaultEmail ?? '',
      notes: '',
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    const pad = padRef.current;
    if (!pad || pad.isEmpty()) {
      toast.error('Please sign before submitting.');
      return;
    }
    const signatureDataUrl = pad.toDataURL();
    if (!signatureDataUrl || !signatureDataUrl.startsWith('data:image/png')) {
      toast.error('Could not capture signature. Please try again.');
      return;
    }
    const res = await submitShipmentSignatureAction({
      token,
      signatureDataUrl,
      signedByName: values.signedByName,
      email: values.email,
      notes:
        values.notes && values.notes.trim().length > 0 ? values.notes : null,
    });
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    onSigned({ signedByName: values.signedByName, email: values.email });
  });

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <div className="space-y-2">
        <Label className="text-muted-foreground text-[11px] font-semibold uppercase tracking-[0.12em]">
          Signature
        </Label>
        <SignaturePad ref={padRef} onChange={(empty) => setPadEmpty(empty)} />
        <p className="text-muted-foreground text-xs">
          Use your finger or stylus. Tap <span className="font-medium">Clear</span>{' '}
          to start over.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="signedByName">Print name</Label>
        <Input
          id="signedByName"
          autoComplete="name"
          placeholder="Your full name"
          {...register('signedByName')}
          aria-invalid={!!errors.signedByName}
        />
        {errors.signedByName ? (
          <p className="text-destructive text-xs">{errors.signedByName.message}</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="email">Email a copy to</Label>
        <Input
          id="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@company.com"
          {...register('email')}
          aria-invalid={!!errors.email}
        />
        {errors.email ? (
          <p className="text-destructive text-xs">{errors.email.message}</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="notes">Notes (optional)</Label>
        <Textarea
          id="notes"
          rows={3}
          placeholder="Anything we should know about the delivery?"
          {...register('notes')}
        />
      </div>

      <Button
        type="submit"
        className="w-full"
        variant="gradient"
        size="lg"
        disabled={isSubmitting || padEmpty}
      >
        {isSubmitting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          'Sign & send copy'
        )}
      </Button>
      <p className="text-muted-foreground text-center text-[11px]">
        By signing, you confirm that the items listed above were received in good
        condition.
      </p>
    </form>
  );
}
