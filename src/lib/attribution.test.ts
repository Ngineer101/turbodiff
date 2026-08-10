import { describe, expect, it } from 'vite-plus/test';
import { coauthorTrailer, gitAuthorEnv, noreplyEmail } from './attribution.ts';

const user = { login: 'octocat', id: 583231 };

describe('noreplyEmail', () => {
  it('builds the id+login noreply form GitHub links to the account', () => {
    expect(noreplyEmail(user)).toBe('583231+octocat@users.noreply.github.com');
  });
});

describe('gitAuthorEnv', () => {
  it('produces GIT_AUTHOR_* env for an instructing user', () => {
    expect(gitAuthorEnv(user)).toEqual({
      GIT_AUTHOR_NAME: 'octocat',
      GIT_AUTHOR_EMAIL: '583231+octocat@users.noreply.github.com',
    });
  });

  it('is empty when no human instructed the run (bot stays author)', () => {
    expect(gitAuthorEnv(null)).toEqual({});
    expect(gitAuthorEnv(undefined)).toEqual({});
  });
});

describe('coauthorTrailer', () => {
  it('emits a blank-line-separated git trailer', () => {
    expect(coauthorTrailer(user)).toBe(
      '\n\nCo-authored-by: octocat <583231+octocat@users.noreply.github.com>',
    );
  });

  it('is empty without a coauthor', () => {
    expect(coauthorTrailer(null)).toBe('');
  });
});
