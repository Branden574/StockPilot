import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy · StockPilot',
  description:
    'How StockPilot collects, stores, and protects the data you and your organization put into the app.',
};

const EFFECTIVE_DATE = 'May 27, 2026';

/**
 * Plain-language privacy policy. Required for App Store submission
 * (Apple needs a live privacy-policy URL on the listing) and for
 * Google Play. This page is intentionally written for end users —
 * if any of the sections grow legally complex they should be reviewed
 * by counsel before public launch.
 */
export default function PrivacyPolicyPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 text-[15px] leading-7 text-foreground">
      <h1 className="text-4xl font-semibold tracking-tight">Privacy Policy</h1>
      <p className="mt-2 text-sm text-muted-foreground">Effective {EFFECTIVE_DATE}</p>

      <Section title="Summary">
        StockPilot is an inventory-management application used by organizations to
        track items, locations, purchase orders, and related operations. We
        collect only what is necessary to run the service. We do not sell your
        data. We do not show third-party advertising. You can delete your
        account at any time from inside the app or the web dashboard.
      </Section>

      <Section title="What we collect">
        <List>
          <li>
            <strong>Account information:</strong> email, full name, and an
            optional profile photo you upload yourself.
          </li>
          <li>
            <strong>Organization data:</strong> inventory items, categories,
            locations, suppliers, purchase orders, cycle counts, and related
            records your organization creates while using the app.
          </li>
          <li>
            <strong>Device information:</strong> when you sign in on a mobile
            device, we record a push-notification token (so we can deliver app
            notifications), the device model, and the operating-system version.
            Push tokens are stored only while the device is registered; they
            are removed when you sign out or when the OS rotates the token.
          </li>
          <li>
            <strong>Authentication metadata:</strong> session timestamps and
            sign-in IP address (used only for security review of suspicious
            access).
          </li>
          <li>
            <strong>Audit log entries:</strong> a record of significant actions
            you perform (creating a PO, deleting an item, etc.) so your
            organization can review history.
          </li>
        </List>
      </Section>

      <Section title="What we do not collect">
        <List>
          <li>We do not collect contacts, photos outside the ones you attach to inventory items, microphone audio, or precise location.</li>
          <li>We do not run third-party advertising or analytics SDKs inside the mobile app.</li>
          <li>We do not sell or rent your personal information to anyone.</li>
        </List>
      </Section>

      <Section title="How we use the data">
        <List>
          <li>To operate the service — show your inventory, deliver push notifications you subscribed to, sync changes between web and mobile.</li>
          <li>To enforce access controls (only your organization can see your organization’s data).</li>
          <li>To investigate security incidents and abuse.</li>
          <li>To improve the service through aggregated, non-identifying usage signals (e.g., which features are used most).</li>
        </List>
      </Section>

      <Section title="Where the data lives">
        <p>
          StockPilot stores data with our hosting providers Supabase
          (PostgreSQL database, storage buckets, authentication) and Vercel
          (web hosting). Both providers maintain SOC 2 Type II certified
          infrastructure. Data is encrypted in transit (TLS) and at rest.
        </p>
      </Section>

      <Section title="Push notifications">
        <p>
          Push tokens are forwarded to Apple’s APNs service (iOS) and Google’s
          FCM service (Android) only to deliver notifications you have opted
          into. Notification payloads contain only the minimum needed to render
          the alert (subject, short body, deep-link path).
        </p>
      </Section>

      <Section title="Your rights">
        <List>
          <li>
            <strong>Access:</strong> you can see every item, PO, and audit row
            attached to your organization from inside the dashboard.
          </li>
          <li>
            <strong>Export:</strong> CSV export is available from the inventory
            and reports surfaces.
          </li>
          <li>
            <strong>Deletion:</strong> you can permanently delete your account
            from inside the mobile app (Settings → Delete my account) or the
            web app (Settings → Account). Deletion removes your profile, your
            push tokens, and your access. Records you authored that are still
            needed by your organization (audit history, PO authorship, etc.)
            are tombstoned with a deleted-user marker rather than erased, so
            your organization can audit the history.
          </li>
          <li>
            <strong>Correction:</strong> profile fields can be edited at any
            time from Settings → Profile.
          </li>
        </List>
      </Section>

      <Section title="Children">
        <p>
          StockPilot is a business-operations tool and is not directed at
          children under 13. We do not knowingly collect data from anyone
          under 13.
        </p>
      </Section>

      <Section title="Changes to this policy">
        <p>
          We may update this policy as the product evolves. Material changes
          will be announced in-app and via email to organization owners at
          least 14 days before they take effect.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          Questions about this policy? Email{' '}
          <a className="underline" href="mailto:hello@stockpilot.app">
            hello@stockpilot.app
          </a>
          .
        </p>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <div className="mt-3 text-muted-foreground">{children}</div>
    </section>
  );
}

function List({ children }: { children: React.ReactNode }) {
  return <ul className="mt-2 list-disc space-y-2 pl-5">{children}</ul>;
}
