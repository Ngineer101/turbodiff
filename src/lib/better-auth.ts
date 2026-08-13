import { env } from 'cloudflare:workers';
import { betterAuth } from 'better-auth';

// Identity and sessions via better-auth (tables in migrations/0026_better_auth.sql).
// Design notes:
//
//   - Sessions are durable D1 rows with a 30-day sliding window — signing out
//     is an explicit act, never a side effect of a GitHub hiccup (the old
//     stateless cookie died at the 8h GitHub token expiry and was deleted on
//     any failed GitHub call; see requireUser in auth.ts for the other half).
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
    account: { encryptOAuthTokens: true },
    advanced: { cookiePrefix: 'turbodiff' },
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
export interface AuthUser {
  id: string;
  login?: string | null;
  githubId?: number | null;
}
