import { describe, expect, it } from 'vite-plus/test';
import { runnerCommand, scrubSecrets, type RunnerAuth } from './fixer.ts';

const claudeAuth: RunnerAuth = {
  mode: 'claude_subscription',
  runner: 'claude',
  vars: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-secret-token' },
  secrets: ['sk-secret-token'],
};

const codexAuth: RunnerAuth = {
  mode: 'codex_api_key',
  runner: 'codex',
  vars: { OPENAI_API_KEY: 'oai-secret-key' },
  secrets: ['oai-secret-key'],
};

describe('scrubSecrets', () => {
  it('replaces every resolved secret value with a placeholder', () => {
    expect(scrubSecrets('token was sk-secret-token in the log', claudeAuth)).toBe(
      'token was *** in the log',
    );
  });

  it('leaves output unchanged when no secret appears', () => {
    expect(scrubSecrets('nothing sensitive here', claudeAuth)).toBe('nothing sensitive here');
  });

  it('never touches non-secret fields like base_url', () => {
    const auth: RunnerAuth = {
      mode: 'gateway',
      runner: 'claude',
      vars: { ANTHROPIC_BASE_URL: 'https://gateway.example.com', ANTHROPIC_API_KEY: 'key-123' },
      secrets: ['key-123'],
    };
    expect(scrubSecrets('endpoint https://gateway.example.com used key-123', auth)).toBe(
      'endpoint https://gateway.example.com used ***',
    );
  });
});

describe('runnerCommand', () => {
  it('builds the Claude Code headless invocation', () => {
    expect(runnerCommand(claudeAuth, '/workspace/task.md')).toBe(
      'claude -p --dangerously-skip-permissions --output-format text < /workspace/task.md',
    );
  });

  it('adds --model only when requested', () => {
    expect(runnerCommand(claudeAuth, '/workspace/task.md', { model: 'haiku' })).toBe(
      'claude -p --dangerously-skip-permissions --output-format text --model haiku < /workspace/task.md',
    );
  });

  it('builds the Codex headless invocation', () => {
    expect(runnerCommand(codexAuth, '/workspace/task.md')).toBe(
      'codex exec --full-auto --skip-git-repo-check < /workspace/task.md',
    );
  });
});
