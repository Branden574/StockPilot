'use client';

import { Mail } from 'lucide-react';

import {
  canSendReturnRequest,
  RETURN_REQUEST_COPY,
  type OrgEmailRoutingRecipientsDto,
  type ReturnRequestEmailContent,
} from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

import { ReturnRequestAction } from './return-request-action';

/**
 * "Send return request" (F14): the button and its dialog, on the requester's
 * own request on the order page and in the return page's header. The twin of
 * the order page's "Send delivery request"
 * (components/orders/send-delivery-request-button.tsx): a plain outline
 * button, the shared dialog, and the dialog header's Liquid Glass hook.
 *
 * It renders nothing unless the server resolved a mailbox pair (recipients)
 * and the return is still open with a number (core canSendReturnRequest, the
 * rule the server's record applies too). A button here is never permission:
 * the page decides who gets it, and the record checks again.
 */
export function SendReturnRequestButton({
  orderId,
  surface,
  content,
  recipients,
  size,
}: {
  orderId: string;
  surface: 'order' | 'return';
  content: ReturnRequestEmailContent | null;
  recipients: OrgEmailRoutingRecipientsDto | null;
  size?: 'default' | 'sm';
}) {
  if (!content || !recipients) return null;
  if (!canSendReturnRequest(content.status, content.returnNumber)) return null;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size={size}>
          <Mail className="h-3.5 w-3.5" aria-hidden="true" />
          {RETURN_REQUEST_COPY.title}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader data-glass="dialog-header">
          <DialogTitle>{RETURN_REQUEST_COPY.title}</DialogTitle>
          <DialogDescription>{RETURN_REQUEST_COPY.description}</DialogDescription>
        </DialogHeader>
        <ReturnRequestAction orderId={orderId} surface={surface} content={content} recipients={recipients} />
      </DialogContent>
    </Dialog>
  );
}
