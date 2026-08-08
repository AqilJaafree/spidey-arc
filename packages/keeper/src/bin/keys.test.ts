import { describe, expect, it } from 'vitest';
import { reporterMode } from './keys.js';

describe('reporterMode', () => {
  it('posts when a key is set', () => {
    expect(reporterMode({ REPORTER_KEY: '0xabc' })).toEqual({ readOnly: false, key: '0xabc' });
  });

  it('runs read-only when the flag asks for it', () => {
    expect(reporterMode({ KEEPER_READ_ONLY: '1' })).toEqual({ readOnly: true });
  });

  it('refuses to start when the key is missing and nobody asked for read-only', () => {
    // The whole point of the module. Falling back here is what turns a typo'd
    // variable name into fifteen-minute green ticks over an ageing mark.
    expect(() => reporterMode({})).toThrow(/REPORTER_KEY/);
    expect(() => reporterMode({})).toThrow(/KEEPER_READ_ONLY/);
  });

  it('names both variables so the message says what to do about it', () => {
    // Asserted as one string too: the two matches above would also pass if the
    // names landed in separate sentences of an otherwise useless error.
    expect(() => reporterMode({})).toThrow(
      /REPORTER_KEY[\s\S]*post[\s\S]*KEEPER_READ_ONLY[\s\S]*read-only/,
    );
  });

  it('treats an empty or whitespace key as no key at all', () => {
    // `REPORTER_KEY=` in a Railway variable list is the typo case wearing a
    // different hat, and `''` is falsy in exactly the way that hides it.
    expect(() => reporterMode({ REPORTER_KEY: '' })).toThrow(/REPORTER_KEY/);
    expect(() => reporterMode({ REPORTER_KEY: '   ' })).toThrow(/REPORTER_KEY/);
  });

  it('prefers read-only when the key and the flag are both present', () => {
    // Read-only wins because the failures are not symmetric: a stale flag means
    // no post, announced in every log and fixed by a config change, whereas
    // honouring the key would let a dry run post a real mark to a live vault.
    expect(reporterMode({ REPORTER_KEY: '0xabc', KEEPER_READ_ONLY: '1' })).toEqual({ readOnly: true });
  });

  it('does not read KEEPER_READ_ONLY=0 as a request for read-only', () => {
    expect(reporterMode({ REPORTER_KEY: '0xabc', KEEPER_READ_ONLY: '0' })).toEqual({
      readOnly: false, key: '0xabc',
    });
    expect(reporterMode({ REPORTER_KEY: '0xabc', KEEPER_READ_ONLY: 'false' })).toEqual({
      readOnly: false, key: '0xabc',
    });
    // ...and the refusal still stands when that is the only thing set.
    expect(() => reporterMode({ KEEPER_READ_ONLY: '0' })).toThrow(/REPORTER_KEY/);
  });
});
