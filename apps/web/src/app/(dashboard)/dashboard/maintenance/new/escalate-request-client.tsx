'use client';

import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import {
  escalationAlreadyEscalatedCopy,
  escalationDuplicateCopy,
  type MaintenanceRequestFormValues,
} from '@stockpilot/core';
import {
  MaintenanceRequestForm,
  type MaintenanceFormSubmitResult,
} from '@/components/maintenance/maintenance-request-form';
import { escalateExceptionAction } from '@/server/actions/exceptions';

interface Props {
  occurrenceId: string;
  /** escalationPrefill's subject, description and category (editable). */
  defaults: Partial<MaintenanceRequestFormValues>;
  categories: string[];
}

/**
 * "Escalate to maintenance" (F1-5): the request form, saving through
 * escalateExceptionAction so the ONE request it saves is linked to the
 * exception. Page glue for the same reason as NewMaintenanceRequestClient: a
 * Server Component cannot hand the form a closure.
 *
 * Only the four fields an escalation saves are sent (subject, description,
 * priority, category); the server takes the item and the location from the
 * exception itself. Saved: the request's review screen (?review=1), where the
 * email opens only when the person taps it; nothing opens from here. Already
 * escalated (someone got there first): the request is opened when this person
 * can open it, otherwise they are taken back to the exception, which says so.
 * Online only: a failed save is shown, never queued to retry by itself.
 */
export function EscalateRequestClient({ occurrenceId, defaults, categories }: Props) {
  const router = useRouter();

  async function submit(values: MaintenanceRequestFormValues): Promise<MaintenanceFormSubmitResult> {
    const res = await escalateExceptionAction(occurrenceId, {
      subject: values.subject,
      description: values.description,
      priority: values.priority,
      category: values.category ?? null,
    });
    if ('ok' in res) return { id: res.id };
    const { error } = res;
    if (error.reason === 'already_escalated' && error.requestId) {
      if (error.requestVisible === true) {
        toast.info(escalationDuplicateCopy(error.reference ?? null));
        router.push(`/dashboard/maintenance/${error.requestId}`);
      } else {
        toast.info(escalationAlreadyEscalatedCopy(error.reference ?? null));
        router.push(`/dashboard/exceptions/${occurrenceId}`);
      }
      return { handled: true };
    }
    return { error: { message: error.message } };
  }

  return (
    <MaintenanceRequestForm
      defaults={defaults}
      sites={[]}
      categories={categories}
      coreFieldsOnly
      submit={submit}
      onSaved={(id) => router.push(`/dashboard/maintenance/${id}?review=1`)}
    />
  );
}
