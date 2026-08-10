import { describe, expect, it } from 'vitest';
import { engineIsLocal } from './apiTarget';

describe('engineIsLocal', () => {
  // Decides which advice a failed scan gives. Telling a deployed site's
  // visitor to run `pnpm api` is advice they cannot act on.
  it('recognises a developer running the engine themselves', () => {
    expect(engineIsLocal('http://localhost:8787')).toBe(true);
    expect(engineIsLocal('http://127.0.0.1:8787')).toBe(true);
    expect(engineIsLocal('http://0.0.0.0:8787')).toBe(true);
  });

  it('treats anything hosted as not local', () => {
    expect(engineIsLocal('https://spidey-api.up.railway.app')).toBe(false);
    expect(engineIsLocal('https://api.example.com')).toBe(false);
  });

  // A hostname that merely contains "localhost" is not localhost.
  it('is not fooled by a hostname that embeds the word', () => {
    expect(engineIsLocal('https://localhost.attacker.example')).toBe(false);
  });

  it('treats an unparseable target as not local', () => {
    expect(engineIsLocal('')).toBe(false);
    expect(engineIsLocal('not a url')).toBe(false);
  });
});
