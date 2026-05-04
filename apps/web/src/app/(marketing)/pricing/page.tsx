import { redirect } from 'next/navigation';

/**
 * Pricing no longer applies — this is an internal-company tool, not a
 * paid SaaS. Anyone landing here gets bounced to sign-in.
 */
export default function PricingPage(): never {
  redirect('/signin');
}
