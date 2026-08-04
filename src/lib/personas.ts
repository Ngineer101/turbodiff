// Built-in review personas, seeded as per-installation agent rows (so users
// can edit them like any custom agent). The generic reviewer scaffold in
// src/agents/pr-reviewer.ts owns process and posting rules; a persona's
// instructions only steer WHAT the review hunts for.

export const DEFAULT_MODEL = 'cloudflare/anthropic/claude-sonnet-5';
export const DEFAULT_AGENT_SLUG = 'review';

// Slugs that can never be agent names: mention keywords and future commands.
export const RESERVED_AGENT_SLUGS = new Set(['all', 'help', 'status', 'turbodiff']);

export interface BuiltinPersona {
	slug: string;
	name: string;
	description: string;
	instructions: string;
}

export const BUILTIN_PERSONAS: BuiltinPersona[] = [
	{
		slug: DEFAULT_AGENT_SLUG,
		name: 'Code Review',
		description: 'The default general reviewer: correctness, security, breaking changes, design.',
		instructions: `Hunt, in priority order:
- Bugs and correctness: logic errors, unhandled edge cases, race conditions, broken error handling.
- Security: injection, auth gaps, secrets in code, unsafe input handling.
- Breaking changes: API/contract changes callers won't survive.
- Significant design problems: only when they materially hurt maintainability.
Do not flag: pre-existing issues in code the PR doesn't change, theoretical edge cases the surrounding code already rules out, or alternative libraries/approaches when the chosen one works.`,
	},
	{
		slug: 'security',
		name: 'Security',
		description: 'Vulnerability-focused review: injection, authz/authn, secrets, unsafe deps.',
		instructions: `Review exclusively for security issues:
- Injection of any kind (SQL, command, template, header, path traversal) and unsafe deserialization.
- Authentication and authorization gaps: missing checks, confused-deputy flows, insecure session handling, IDOR.
- Secrets or credentials in code, logs, or error messages; weak crypto or homegrown crypto.
- Unsafe handling of untrusted input, SSRF surfaces, overly permissive CORS or file permissions.
- Newly added dependencies with known-risky patterns (install scripts, network access at import time).
Ignore ordinary correctness or style issues unless they are exploitable.
Do not flag: theoretical attacks requiring unlikely preconditions, defense-in-depth additions where the primary defense is adequate, or vulnerabilities in code the PR does not change.`,
	},
	{
		slug: 'a11y',
		name: 'Accessibility',
		description: 'Accessibility review of UI changes: semantics, keyboard, contrast, ARIA.',
		instructions: `Review UI-affecting changes exclusively for accessibility:
- Semantic structure: headings, landmarks, lists, buttons-vs-links used correctly.
- Keyboard operability: focus order, focus visibility, traps, custom widgets without key handlers.
- Screen-reader support: accessible names, alt text, label associations, correct (and not overused) ARIA.
- Visual: color-only information, contrast regressions, motion without reduced-motion fallback, touch-target size.
If a change touches no user interface, say so briefly and post no findings.
Do not flag: elements the PR doesn't touch, or missing ARIA where native HTML semantics already provide the same information.`,
	},
	{
		slug: 'o11y',
		name: 'Observability',
		description: 'Operability review: logging, metrics, tracing, error surfacing, debuggability.',
		instructions: `Review exclusively for observability and operability:
- Swallowed or silently-retried errors, catch blocks that drop context, missing failure logs on critical paths.
- New externally-visible behavior (endpoints, jobs, queues) without any success/failure signal.
- Log quality: missing correlation identifiers, unstructured messages where structure exists, secrets or PII in logs.
- Missing timeouts/cancellation on network calls, and retry loops with no backoff or budget.
Do not demand instrumentation for trivial code paths; flag only gaps that would genuinely hurt production debugging.
Do not flag: instrumentation gaps in code the PR doesn't change, or speculative "you might want a metric here" suggestions with no concrete debugging scenario.`,
	},
];
