'use client';

import { Loader2, Mail, Wrench } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { useStepUp } from '@/components/auth/step-up-modal';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { setOrgEmailRoutingAction } from '@/server/actions/email-routing-settings';

import {
  brandDeliveryRecipients,
  brandMaintenanceRecipients,
  deliveryRequestCcNotice,
  maintenanceCcNotice,
  type OrgEmailRoutingFeature,
  type OrgEmailRoutingReadState,
} from '@stockpilot/core';

/**
 * Per-org compose-email routing editor (organizations.email_routing,
 * migration 0337) — one card per feature, since the two route independently.
 *
 * VALIDATION IS THE READER'S: `validateFields` below RUNS the same branded
 * factory every compose surface runs (`brandDeliveryRecipients` /
 * `brandMaintenanceRecipients`) inside try/catch, and shows the guard's
 * message verbatim — never a parallel schema that could accept what the read
 * path would refuse. The server action independently re-runs the identical
 * factories and refuses to save on throw, so this client pass is instant
 * feedback, not the boundary.
 *
 * STEP-UP: rerouting warehouse mail is the highest-value write this panel
 * exposes — a hijacked admin session could silently divert every delivery
 * and maintenance request (requester names and emails included) to an
 * attacker mailbox, and the failure would be invisible because mail "still
 * sends". When the action refuses with `details.reason === 'aal2_required'`
 * (an enrolled admin at AAL1), `useStepUp()` challenges the TOTP code
 * in place and retries once. The modal is UX; the action's own MFA check is
 * the guarantee.
 */

interface FeatureCopy {
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  notice: (r: { to: string; cc: string }) => string;
}

const FEATURES: Record<OrgEmailRoutingFeature, FeatureCopy> = {
  delivery_request: {
    title: 'Delivery requests',
    description:
      'Where the "Email delivery request" action on delivery orders addresses its draft.',
    icon: Mail,
    notice: deliveryRequestCcNotice,
  },
  maintenance_request: {
    title: 'Maintenance requests',
    description: 'Where the maintenance-request email action addresses its draft.',
    icon: Wrench,
    notice: maintenanceCcNotice,
  },
};

interface Fields {
  to: string;
  toName: string;
  cc: string;
  ccName: string;
}

const EMPTY_FIELDS: Fields = { to: '', toName: '', cc: '', ccName: '' };

function fieldsFromRouting(routing: OrgEmailRoutingReadState): Fields {
  if (routing.state !== 'valid') return EMPTY_FIELDS;
  return {
    to: routing.recipients.to,
    toName: routing.recipients.toName ?? '',
    cc: routing.recipients.cc,
    ccName: routing.recipients.ccName ?? '',
  };
}

/** Mirror of the server action's `normalize`: trim everything, drop empty
 *  display names rather than sending ''. */
function toRecipientsInput(fields: Fields) {
  const toName = fields.toName.trim();
  const ccName = fields.ccName.trim();
  return {
    to: fields.to.trim(),
    cc: fields.cc.trim(),
    ...(toName ? { toName } : {}),
    ...(ccName ? { ccName } : {}),
  };
}

/**
 * Run the READER-SIDE factory on the current fields. Returns the guard's
 * message verbatim, or null when the value would be accepted. Both empty
 * required fields get a plain sentence instead of the factory's (which
 * assumes a value was supplied).
 */
function validateFields(feature: OrgEmailRoutingFeature, fields: Fields): string | null {
  const input = toRecipientsInput(fields);
  if (!input.to || !input.cc) return 'Both a To and a CC address are required.';
  try {
    if (feature === 'delivery_request') brandDeliveryRecipients(input);
    else brandMaintenanceRecipients(input);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Invalid recipients.';
  }
}

function StatusLine({ routing }: { routing: OrgEmailRoutingReadState }) {
  if (routing.state === 'valid') {
    return (
      <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
        Active — members see the email action.
      </p>
    );
  }
  if (routing.state === 'invalid') {
    return (
      <p className="text-destructive text-sm font-medium">
        {`Invalid: ${routing.reason} The email action is hidden until this is fixed.`}
      </p>
    );
  }
  if (routing.state === 'fallback') {
    return (
      <p className="text-amber-600 dark:text-amber-400 text-sm font-medium">
        Email-routing storage is not available yet (a database migration is pending). The
        release&apos;s built-in recipients are in use until it lands; saving here will work after
        the migration.
      </p>
    );
  }
  return (
    <p className="text-muted-foreground text-sm font-medium">
      Not configured — members do not see the email action.
    </p>
  );
}

function FeatureCard({
  feature,
  initial,
  stepUpEnsure,
}: {
  feature: OrgEmailRoutingFeature;
  initial: OrgEmailRoutingReadState;
  stepUpEnsure: () => Promise<boolean>;
}) {
  const router = useRouter();
  const copy = FEATURES[feature];
  const Icon = copy.icon;
  const [fields, setFields] = React.useState<Fields>(() => fieldsFromRouting(initial));
  // Shown only after blur/save so a half-typed address is not nagged.
  const [fieldError, setFieldError] = React.useState<string | null>(null);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [confirmClear, setConfirmClear] = React.useState(false);

  const validation = validateFields(feature, fields);
  const preview = validation === null ? copy.notice(toRecipientsInput(fields)) : null;

  function set<K extends keyof Fields>(key: K, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }));
    // A keystroke invalidates the last blur verdict; re-shown on next blur.
    setFieldError(null);
  }

  async function callAction(recipients: ReturnType<typeof toRecipientsInput> | null) {
    let res = await setOrgEmailRoutingAction({ feature, recipients });
    // Fresh MFA step-up needed -> challenge the authenticator code in place
    // (no sign-out) and retry the identical payload once.
    if (!res.ok && res.error.details?.reason === 'aal2_required') {
      if (!(await stepUpEnsure())) return null;
      res = await setOrgEmailRoutingAction({ feature, recipients });
    }
    return res;
  }

  async function save() {
    const invalid = validateFields(feature, fields);
    if (invalid) {
      setFieldError(invalid);
      return;
    }
    setServerError(null);
    setBusy(true);
    const res = await callAction(toRecipientsInput(fields));
    setBusy(false);
    if (!res) return; // step-up dismissed
    if (!res.ok) {
      setServerError(res.error.message);
      return;
    }
    toast.success(`${copy.title} email routing saved.`);
    router.refresh();
  }

  async function clearRouting() {
    setServerError(null);
    setBusy(true);
    const res = await callAction(null);
    setBusy(false);
    setConfirmClear(false);
    if (!res) return;
    if (!res.ok) {
      setServerError(res.error.message);
      return;
    }
    setFields(EMPTY_FIELDS);
    toast.success(`${copy.title} email routing cleared. Members no longer see the email action.`);
    router.refresh();
  }

  const idPrefix = feature.replace('_', '-');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="h-4 w-4" /> {copy.title}
        </CardTitle>
        <CardDescription>{copy.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <StatusLine routing={initial} />

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-to`}>To address (required)</Label>
            <Input
              id={`${idPrefix}-to`}
              type="email"
              value={fields.to}
              onChange={(e) => set('to', e.target.value)}
              onBlur={() => setFieldError(validateFields(feature, fields))}
              placeholder="intake@yourwarehouse.org"
              disabled={busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-to-name`}>To display name (optional)</Label>
            <Input
              id={`${idPrefix}-to-name`}
              value={fields.toName}
              onChange={(e) => set('toName', e.target.value)}
              onBlur={() => setFieldError(validateFields(feature, fields))}
              placeholder="Warehouse Intake"
              disabled={busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-cc`}>CC address (required)</Label>
            <Input
              id={`${idPrefix}-cc`}
              type="email"
              value={fields.cc}
              onChange={(e) => set('cc', e.target.value)}
              onBlur={() => setFieldError(validateFields(feature, fields))}
              placeholder="manager@yourwarehouse.org"
              disabled={busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-cc-name`}>CC display name (optional)</Label>
            <Input
              id={`${idPrefix}-cc-name`}
              value={fields.ccName}
              onChange={(e) => set('ccName', e.target.value)}
              onBlur={() => setFieldError(validateFields(feature, fields))}
              placeholder="Warehouse Manager"
              disabled={busy}
            />
          </div>
        </div>

        {/* Live preview of the exact sentence members read under the email
            action — the same pure notice function the surfaces render, so
            the preview cannot drift from the real screens. */}
        {preview ? (
          <p className="text-muted-foreground rounded-md border border-dashed p-2 text-sm">
            {preview}
          </p>
        ) : null}

        {fieldError ? <p className="text-destructive text-sm">{fieldError}</p> : null}
        {serverError ? <p className="text-destructive text-sm">{serverError}</p> : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void save()} disabled={busy} size="sm">
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            Save routing
          </Button>
          {initial.state === 'valid' || initial.state === 'invalid' ? (
            confirmClear ? (
              <>
                <span className="text-muted-foreground text-xs">
                  Clear routing? Members lose the email action for {copy.title.toLowerCase()}.
                </span>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => void clearRouting()}
                  disabled={busy}
                >
                  Confirm clear
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmClear(false)}
                  disabled={busy}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmClear(true)}
                disabled={busy}
              >
                Clear routing
              </Button>
            )
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function EmailRoutingPanel({
  initialDelivery,
  initialMaintenance,
}: {
  initialDelivery: OrgEmailRoutingReadState;
  initialMaintenance: OrgEmailRoutingReadState;
}) {
  // ONE step-up modal shared by both cards — two mounted modals would race
  // their open state over a single save.
  const stepUp = useStepUp();
  return (
    <div className="space-y-6">
      {stepUp.modal}
      <FeatureCard
        feature="delivery_request"
        initial={initialDelivery}
        stepUpEnsure={stepUp.ensure}
      />
      <FeatureCard
        feature="maintenance_request"
        initial={initialMaintenance}
        stepUpEnsure={stepUp.ensure}
      />
      <p className="text-muted-foreground text-xs">
        StockPilot opens prefilled drafts in the sender&apos;s own mail app and cannot observe
        whether a message is ultimately sent or received. Configure addresses your organization
        actually monitors.
      </p>
    </div>
  );
}
