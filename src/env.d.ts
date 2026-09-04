declare namespace Cloudflare {
  interface Env {
    CLAUDE_CODE_OAUTH_TOKEN: string;
    FIXER_ANTHROPIC_API_KEY: string;
    GITHUB_APP_ID: string;
    GITHUB_APP_PRIVATE_KEY: string;
    GITHUB_OAUTH_CLIENT_ID: string;
    GITHUB_OAUTH_CLIENT_SECRET: string;
    GITHUB_WEBHOOK_SECRET: string;
    RESEND_API_KEY: string;
    REVIEW_SECRET: string;
    SESSION_SECRET: string;
    // Optional secret: when absent/empty, /api/skills/catalog reports
    // unconfigured and only GitHub-direct skill import works.
    SKILLS_SH_API_TOKEN: string;
    VAPID_PRIVATE_KEY: string;
    // Public by design (browsers receive it from /api/me), but kept out of
    // wrangler.jsonc so forks don't inherit this deployment's key.
    VAPID_PUBLIC_KEY: string;
    VAPID_SUBJECT: string; // e.g. "mailto:ops@turbodiff.dev"
  }
}
