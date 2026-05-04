import { redirect } from 'next/navigation';

/**
 * Short alias for /invite/[token]. Exists to keep the shareable invite URL
 * compact enough to fit on a single line in chat clients (Teams/Slack/iMessage)
 * without word-wrapping into a broken link.
 *
 * Server-side 308 redirect — preserves the token and all query params.
 */
export default async function ShortInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  redirect(`/invite/${token}`);
}
