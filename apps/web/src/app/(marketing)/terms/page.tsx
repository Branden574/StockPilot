import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Terms of Service · StockPilot',
  description:
    'The terms under which you may use StockPilot’s mobile and web applications.',
};

const EFFECTIVE_DATE = 'May 27, 2026';

/**
 * Plain-language terms of service. Required for the App Store listing
 * EULA section (Apple supplies a default; we link to ours so the
 * terms match the actual product). Treat this as a starting point —
 * have counsel review before public launch.
 */
export default function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 text-[15px] leading-7 text-foreground">
      <h1 className="text-4xl font-semibold tracking-tight">Terms of Service</h1>
      <p className="mt-2 text-sm text-muted-foreground">Effective {EFFECTIVE_DATE}</p>

      <Section title="Acceptance">
        By creating a StockPilot account or installing the StockPilot mobile
        application, you agree to these Terms. If you are using StockPilot on
        behalf of an organization, you represent that you have authority to
        bind that organization to these Terms.
      </Section>

      <Section title="The service">
        StockPilot is software that helps organizations track inventory items,
        locations, purchase orders, and related operational data. It is provided
        as-is and may change as we add features, fix bugs, and respond to
        feedback.
      </Section>

      <Section title="Your account">
        <List>
          <li>You must provide accurate sign-up information.</li>
          <li>You are responsible for safeguarding your password and any device that has biometric unlock enabled for the app.</li>
          <li>You must promptly notify us of unauthorized access at <a className="underline" href="mailto:hello@stockpilot.app">hello@stockpilot.app</a>.</li>
          <li>You may delete your account at any time from Settings → Delete my account in the mobile app or Settings → Account on the web.</li>
        </List>
      </Section>

      <Section title="Acceptable use">
        <List>
          <li>Do not use StockPilot to violate any law or third-party right.</li>
          <li>Do not attempt to disrupt the service, probe it for vulnerabilities outside an authorized program, or access data you are not entitled to.</li>
          <li>Do not upload malware, illegal content, or content you do not have the right to upload.</li>
          <li>Do not resell or sublicense access to the service.</li>
        </List>
      </Section>

      <Section title="Your data">
        Your organization owns the data you put into StockPilot. We process it
        on your behalf, only as needed to operate the service, in accordance
        with our <a className="underline" href="/privacy">Privacy Policy</a>.
      </Section>

      <Section title="Intellectual property">
        The StockPilot name, logo, software, and visual design are owned by
        the StockPilot maintainers. Nothing in these Terms transfers ownership
        of the software to you. You retain ownership of the content you upload.
      </Section>

      <Section title="Termination">
        We may suspend or terminate access if you materially breach these Terms
        — for example, if you abuse the service or attempt to compromise its
        security. You may stop using StockPilot at any time and delete your
        account from inside the app.
      </Section>

      <Section title="Disclaimers">
        StockPilot is provided on an as-is and as-available basis. To the
        maximum extent permitted by law, we disclaim all warranties, express or
        implied, including warranties of merchantability, fitness for a
        particular purpose, and non-infringement.
      </Section>

      <Section title="Limitation of liability">
        To the maximum extent permitted by law, StockPilot and its maintainers
        will not be liable for indirect, incidental, special, consequential, or
        punitive damages, or for any loss of profits, revenues, data, or
        goodwill arising out of your use of the service. Total liability for
        any claim arising out of or relating to the service is limited to
        US$100.
      </Section>

      <Section title="Governing law">
        These Terms are governed by the laws of the State of California, USA,
        without regard to its conflict-of-laws principles. Disputes will be
        resolved exclusively in the state or federal courts located in
        California.
      </Section>

      <Section title="Changes">
        We may update these Terms as the product evolves. Material changes
        will be announced in-app and via email to organization owners at
        least 14 days before they take effect. Continued use after the
        effective date constitutes acceptance.
      </Section>

      <Section title="Contact">
        Questions? Email{' '}
        <a className="underline" href="mailto:hello@stockpilot.app">
          hello@stockpilot.app
        </a>
        .
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
