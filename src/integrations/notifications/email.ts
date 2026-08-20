import { env } from 'cloudflare:workers';

// Notification integration: thin wrapper around Resend's REST API — plain
// fetch, no SDK, matching how every other external integration in this repo
// talks to its API. One job: organization invite emails.

export async function sendInvitationEmail(opts: {
  to: string;
  orgName: string;
  inviteUrl: string;
  inviterLogin: string;
}): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_ADDRESS,
      to: opts.to,
      subject: `${opts.inviterLogin} invited you to ${opts.orgName} on Turbodiff`,
      html:
        `<p>${opts.inviterLogin} invited you to join <strong>${opts.orgName}</strong> on Turbodiff.</p>` +
        `<p><a href="${opts.inviteUrl}">Accept the invitation</a></p>`,
    }),
  });
  // Fails loudly: an invite that silently never sends is worse than a 500
  // the admin can retry.
  if (!res.ok) {
    throw new Error(
      `Resend invitation email to ${opts.to} failed: ${res.status} ${(await res.text()).slice(0, 300)}`,
    );
  }
}
