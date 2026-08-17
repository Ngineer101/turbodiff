import { env } from 'cloudflare:workers';
import { betterAuth } from 'better-auth';

// Identity and sessions via better-auth (tables in migrations/0026_better_auth.sql).
// Design notes:
//
//   - Sessions are durable D1 rows with a 30-day sliding window — signing out
//     is an explicit act, never a side effect of a GitHub hiccup (the old
//     stateless cookie died at the 8h GitHub token expiry and was deleted on
//     any failed GitHub call; see requireUser in auth.ts for the other half).
//   - Two ways in: GitHub OAuth and email/password (emailAndPassword). A
//     password user has no login/githubId until they link GitHub from
//     /onboarding (auth().api.linkSocialAccount); requireUser treats that as
//     a valid session with zero installations, not as signed out. Email
//     verification and password reset wait on an email provider (Resend,
//     separate PR) — sign-ups are unverified for now.
//   - Account linking: github is a trusted provider, so a GitHub sign-in
//     whose email matches an existing password account attaches to it (one
//     user, both methods). Caveat until verification ships: better-auth's
//     requireLocalEmailVerified (default true, deliberately kept) refuses to
//     implicitly link onto an unverified local account — otherwise anyone
//     could pre-register a password account with someone else's email and
//     capture their later GitHub sign-in. So auto-link starts working once
//     email verification lands; until then a same-email GitHub sign-in
//     errors instead of linking. The explicit "Connect GitHub" flow is
//     unaffected. allowDifferentEmails covers that explicit flow — the
//     GitHub email rarely matches the signup email — and
//     updateUserInfoOnLink copies login/githubId onto the user row at link
//     time (linking skips mapProfileToUser otherwise, and requireUser keys
//     on those fields).
//   - The user.update.before hook drops email/emailVerified from any update
//     that carries githubId — that combination only occurs on the
//     overrideUserInfoOnSignIn profile sync, which would otherwise rewrite a
//     linked user's email to the GitHub address on every GitHub sign-in and
//     silently change their password-login identifier. (Trade-off: GitHub
//     email changes no longer propagate to GitHub-only users either;
//     nothing keys on email, so that drift is cosmetic.)
//   - The github "account" row is the single store for the user's OAuth
//     access/refresh token pair, encrypted at rest (encryptOAuthTokens).
//     auth.api.getAccessToken refreshes it near expiry and persists the
//     rotated refresh token — nothing else may refresh this credential, or
//     GitHub's rotation invalidates whichever copy refreshed last (the legacy
//     user_tokens store is read-only fallback now; see user-tokens.ts).
//   - The GitHub App's OAuth callback URL stays /auth/callback (registered
//     with GitHub): ui.ts rewrites it into this handler's
//     /api/auth/callback/github route, so no App settings change on deploy.
//   - GitHub Apps don't grant the user:email scope unless the App has the
//     Email addresses permission; mapProfileToUser falls back to the noreply
//     address so sign-in never depends on it. login/githubId are the fields
//     the rest of the app actually keys on (attribution, user_tokens).
//   - login/githubId must NOT be declared with input: false: better-auth
//     strips input:false fields from the mapProfileToUser result before
//     creating the user (parseAdditionalUserInputFromProviderProfile), so
//     they would never persist and requireUser would 401 every session.
//     The fields stay server-owned anyway — app.ts closes /update-user, the
//     only route that accepts user additional fields as client input, and
//     overrideUserInfoOnSignIn rewrites them from the GitHub profile on
//     every sign-in (which also repairs rows created while the bug shipped,
//     and tracks GitHub username renames).

const SESSION_DAYS = 30;

// Inference must own the instance type: betterAuth is deeply generic over its
// options, and annotating with ReturnType<typeof betterAuth> collapses that
// to Auth<BetterAuthOptions>, which the concrete instance doesn't satisfy.
function createAuth() {
  return betterAuth({
    baseURL: env.PUBLIC_BASE_URL,
    basePath: '/api/auth',
    secret: env.SESSION_SECRET,
    database: env.DB,
    session: {
      expiresIn: SESSION_DAYS * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
      // Signed cookie snapshot: polling requests (the board refetches every
      // 5s while agents run) skip the D1 session read for 5 minutes.
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    account: {
      encryptOAuthTokens: true,
      accountLinking: {
        trustedProviders: ['github'],
        allowDifferentEmails: true,
        updateUserInfoOnLink: true,
      },
    },
    advanced: { cookiePrefix: 'turbodiff' },
    // Password sign-up/sign-in. requireEmailVerification stays off until an
    // email provider lands (Resend, separate PR) — there is no way to send
    // the verification mail yet.
    emailAndPassword: { enabled: true },
    databaseHooks: {
      user: {
        update: {
          // See design notes: a provider-profile sync (the only update that
          // carries githubId) must never rewrite the email a password user
          // signs in with. Merging undefined removes the fields — the
          // adapter drops undefined columns from the UPDATE.
          before: async (user) =>
            'githubId' in user
              ? { data: { ...user, email: undefined, emailVerified: undefined } }
              : { data: user },
        },
      },
    },
    socialProviders: {
      github: {
        clientId: env.GITHUB_OAUTH_CLIENT_ID,
        clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
        redirectURI: `${env.PUBLIC_BASE_URL}/auth/callback`,
        overrideUserInfoOnSignIn: true,
        mapProfileToUser: (profile) => ({
          login: profile.login,
          githubId: profile.id,
          name: profile.name ?? profile.login,
          email: profile.email ?? `${profile.id}+${profile.login}@users.noreply.github.com`,
        }),
      },
    },
    user: {
      additionalFields: {
        login: { type: 'string', required: false },
        githubId: { type: 'number', required: false },
      },
    },
  });
}

let instance: ReturnType<typeof createAuth> | undefined;

export function auth() {
  instance ??= createAuth();
  return instance;
}

// The better-auth user with Turbodiff's additional fields, as returned by
// auth().api.getSession — typed here once instead of casting at call sites.
// login/githubId are null until a GitHub account is linked (email/password
// sign-ups start without one).
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  login?: string | null;
  githubId?: number | null;
}
