import type { Metadata } from 'next';

import type { LegalDocument } from './parts';

import { PRIVACY_EMAIL } from '@/lib/site';

/**
 * The security page's words and metadata, shared by the classic /security
 * page and its glass twin (see ./parts.ts). Public-facing security posture
 * page. Describes practices that are actually implemented in the product
 * (tenant isolation, MFA, encryption, backups, audit logging, abuse protection,
 * secure development). Intentionally makes NO certification claims (no SOC 2 /
 * ISO badge): it describes what we do, not a cert we hold. Useful for buyer
 * security questionnaires and investor DD.
 */
export const SECURITY_METADATA: Metadata = {
  // The root layout's title template adds " · StockPilot" (CONFLICTS D15).
  title: 'Security & Compliance',
  description:
    'How StockPilot keeps each organization’s data isolated, encrypted, backed up, and access-controlled — the security posture in plain language.',
};

export const SECURITY: LegalDocument = {
  heading: 'Security & Compliance',
  dateLabel: 'Last updated',
  date: 'June 18, 2026',
  sections: [
    {
      title: 'Summary',
      // prettier-ignore
      body: () => (
        <>
          StockPilot is a multi-tenant SaaS built so that every organization’s data is
          isolated at the database level, encrypted in transit and at rest, backed up and
          recoverable, and reachable only by the people that organization authorizes. The
          sections below describe the controls we actually run today. We do not currently
          hold a formal SOC&nbsp;2 or ISO&nbsp;27001 certification — this page describes our
          practices, not a certificate, and we’ll say so plainly until that changes.
        </>
      ),
    },
    {
      title: 'Tenant isolation',
      // prettier-ignore
      body: () => (
        <>
          <p>
            Every record in the database carries an <code>organization_id</code>, and access
            is enforced by Postgres <strong>row-level security (RLS)</strong> — not by
            application code that could be bypassed. A signed-in user can only read or write
            rows for organizations they are an accepted member of; the database itself
            refuses everything else. This is the load-bearing control, and it is verified by
            adversarial security review (see “Secure development”).
          </p>
        </>
      ),
    },
    {
      title: 'Authentication & access control',
      short: 'Authentication & access',
      // prettier-ignore
      body: ({ List }) => (
        <>
          <List>
            <li>
              <strong>Passwords</strong> are handled by our authentication provider
              (Supabase Auth) and are never stored by the application.
            </li>
            <li>
              <strong>Multi-factor authentication (TOTP/2FA)</strong> is supported, and an
              organization can require it for its admins or all members. Sensitive actions
              require a fresh second-factor step-up.
            </li>
            <li>
              <strong>Role-based access</strong> — Owner, Admin, Manager, Warehouse User,
              and read-only Viewer roles gate every action, with warehouse-level scoping for
              front-line staff.
            </li>
            <li>
              <strong>New-device sign-in alerts</strong> notify users when their account is
              accessed from an unrecognized device.
            </li>
          </List>
        </>
      ),
    },
    {
      title: 'Encryption',
      // prettier-ignore
      body: ({ List }) => (
        <>
          <List>
            <li>All traffic is served over <strong>TLS (HTTPS)</strong> end to end.</li>
            <li>
              Data is <strong>encrypted at rest</strong> by our managed Postgres and storage
              providers.
            </li>
            <li>
              Third-party credentials (e.g. accounting/shipping integration tokens) are kept
              in an encrypted secrets vault and accessed only by privileged server-side
              processes — never exposed to the browser or written to logs.
            </li>
          </List>
        </>
      ),
    },
    {
      title: 'Backups & recovery',
      // prettier-ignore
      body: ({ List }) => (
        <>
          <List>
            <li>
              The production database has <strong>point-in-time recovery</strong> through our
              managed database provider.
            </li>
            <li>
              Organizations can additionally capture their own <strong>restore points</strong>{' '}
              (inventory snapshots), taken on demand and on a daily schedule, and roll back to
              one — every restore first takes a fresh “before” snapshot, so a restore is
              itself undoable.
            </li>
            <li>Account and data deletion is self-service and honored at the database level.</li>
          </List>
        </>
      ),
    },
    {
      title: 'Audit logging',
      // prettier-ignore
      body: () => (
        <>
          <p>
            Significant actions — creating or deleting records, role changes, billing
            changes, integration connects, and administrative access — are written to an
            append-only audit log scoped to each organization, so owners can review who did
            what and when.
          </p>
        </>
      ),
    },
    {
      title: 'Abuse & availability protection',
      short: 'Abuse & availability',
      // prettier-ignore
      body: ({ List }) => (
        <>
          <List>
            <li>
              A <strong>web application firewall and bot protection</strong> sit in front of
              the application at the edge.
            </li>
            <li>
              Sensitive and public endpoints are <strong>rate-limited</strong> (fail-closed)
              to prevent brute-force, scraping, and cost-amplification abuse.
            </li>
            <li>
              Security-relevant events (new-device logins, MFA changes, API-key changes, role
              changes) can be streamed to an organization’s alerting channel in real time.
            </li>
          </List>
        </>
      ),
    },
    {
      title: 'Secure development',
      // prettier-ignore
      body: ({ List }) => (
        <>
          <List>
            <li>
              Every change runs through <strong>continuous integration</strong> — type
              checking, an automated test suite (1,000+ tests), database tests, and a full
              build — before it can ship.
            </li>
            <li>
              Dependencies are monitored for known vulnerabilities with automated security
              updates.
            </li>
            <li>
              Major features and the whole codebase undergo <strong>adversarial security
              review</strong> focused on cross-tenant access, authentication, and data
              integrity before release.
            </li>
          </List>
        </>
      ),
    },
    {
      title: 'Data ownership',
      // prettier-ignore
      body: ({ Link }) => (
        <>
          <p>
            Your organization’s data is yours. You can export inventory and operational
            records to CSV/Excel/PDF at any time, and deleting your account removes your
            data. We do not sell data or run third-party advertising. See our{' '}
            <Link href="/privacy">
              Privacy Policy
            </Link>{' '}
            for the full detail on what we collect and why.
          </p>
        </>
      ),
    },
    {
      title: 'Sub-processors',
      // prettier-ignore
      body: () => (
        <>
          <p>
            We rely on a small set of reputable infrastructure providers to run the service —
            hosting/CDN, managed Postgres &amp; authentication, transactional email, and
            payment processing. Each processes only the data needed for its function. A
            current list is available to customers on request.
          </p>
        </>
      ),
    },
    {
      title: 'Reporting a vulnerability',
      // prettier-ignore
      body: ({ Link }) => (
        <>
          <p>
            If you believe you’ve found a security issue, please email{' '}
            <Link href={`mailto:${PRIVACY_EMAIL}`}>
              {PRIVACY_EMAIL}
            </Link>{' '}
            with the details. We investigate every report and will not pursue good-faith
            researchers who follow responsible-disclosure practices.
          </p>
        </>
      ),
    },
  ],
};
