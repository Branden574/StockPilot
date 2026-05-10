'use client';

import * as React from 'react';

import { SignatureConfirmation } from './signature-confirmation';
import { SignatureForm } from './signature-form';

interface PublicSignaturePageProps {
  token: string;
  workOrderNumber: string;
  defaultEmail: string | null;
}

/**
 * Tiny client wrapper that swaps the signature form for the success card
 * once the recipient submits. Lives in /s/[token] so the page can stay a
 * server component for data loading + branding.
 */
export function PublicSignaturePage({
  token,
  workOrderNumber,
  defaultEmail,
}: PublicSignaturePageProps) {
  const [signed, setSigned] = React.useState<
    null | { signedByName: string; email: string }
  >(null);

  if (signed) {
    return (
      <SignatureConfirmation
        signedByName={signed.signedByName}
        email={signed.email}
        workOrderNumber={workOrderNumber}
      />
    );
  }

  return (
    <SignatureForm
      token={token}
      defaultEmail={defaultEmail}
      onSigned={(info) => setSigned(info)}
    />
  );
}
