import { describe, expect, it } from 'vitest';
import { buildScoreTree, hashPair, leafHash, verifyProof, type ScoreLeaf } from './merkle.js';

/**
 * Cross-language conformance.
 *
 * These constants were computed independently on the Solidity side with
 * `cast`, not by this code:
 *
 *   cast abi-encode "f(uint16,uint32,uint32,uint64)" 1 5000 900 1770000000
 *   cast keccak <that>            # inner
 *   cast keccak <inner>           # leaf
 *
 * If either the TypeScript encoder or `ScoreOracle.leafHash` drifts, these
 * fail — which is the point. Drift here would not surface as a broken test in
 * normal operation; it would surface as every `rebalance` reverting with
 * `BadProof` while the vault silently stopped rebalancing.
 */
const ASOF = 1_770_000_000;

const VENUE_1: ScoreLeaf = { venueId: 1, scoreBps: 5_000, netApyBps: 900, asOf: ASOF };
const VENUE_2: ScoreLeaf = { venueId: 2, scoreBps: 6_000, netApyBps: 1_200, asOf: ASOF };

const LEAF_1 = '0x0aaa574e41773eb20eb3edfcc6d629be1639fd605dcd4525abbbf764e4517a39';
const LEAF_2 = '0xd883c16f9cb08a239ac51be3ae46a316cde5537d3cf7a8b14023130d74f21cb2';

describe('§5.2 leaf encoding matches ScoreOracle.leafHash', () => {
  it('reproduces the Solidity-computed leaf for venue 1', () => {
    expect(leafHash(VENUE_1)).toBe(LEAF_1);
  });

  it('reproduces the Solidity-computed leaf for venue 2', () => {
    expect(leafHash(VENUE_2)).toBe(LEAF_2);
  });

  it('is sensitive to every field', () => {
    const base = leafHash(VENUE_1);
    expect(leafHash({ ...VENUE_1, venueId: 2 })).not.toBe(base);
    expect(leafHash({ ...VENUE_1, scoreBps: 5_001 })).not.toBe(base);
    expect(leafHash({ ...VENUE_1, netApyBps: 901 })).not.toBe(base);
    expect(leafHash({ ...VENUE_1, asOf: ASOF + 1 })).not.toBe(base);
  });

  it('double-hashes, so a leaf can never collide with an internal node', () => {
    // A single-hashed leaf would be indistinguishable from a pair hash, which
    // is the second-preimage attack the convention exists to prevent.
    const single = hashPair(LEAF_1 as `0x${string}`, LEAF_2 as `0x${string}`);
    expect(leafHash(VENUE_1)).not.toBe(single);
  });
});

describe('§5.2 pair hashing matches OpenZeppelin MerkleProof', () => {
  it('sorts operands, so order does not change the result', () => {
    const a = LEAF_1 as `0x${string}`;
    const b = LEAF_2 as `0x${string}`;
    expect(hashPair(a, b)).toBe(hashPair(b, a));
  });

  it('produces the root of the two-leaf tree', () => {
    const tree = buildScoreTree([VENUE_1, VENUE_2]);
    expect(tree.root).toBe(hashPair(LEAF_1 as `0x${string}`, LEAF_2 as `0x${string}`));
  });
});

describe('§5.2 tree and proofs', () => {
  it('verifies every leaf of a two-venue tree', () => {
    const entries = [VENUE_1, VENUE_2];
    const tree = buildScoreTree(entries);
    entries.forEach((entry, i) => {
      expect(verifyProof(tree.proofFor(i), tree.root, leafHash(entry))).toBe(true);
    });
  });

  it('verifies every leaf across many tree shapes, including odd counts', () => {
    // Odd levels are where naive implementations diverge from each other.
    for (const count of [1, 2, 3, 5, 8, 13, 40]) {
      const entries: ScoreLeaf[] = Array.from({ length: count }, (_, i) => ({
        venueId: i + 1,
        scoreBps: 1_000 + i,
        netApyBps: 500 + i,
        asOf: ASOF,
      }));
      const tree = buildScoreTree(entries);
      entries.forEach((entry, i) => {
        expect(
          verifyProof(tree.proofFor(i), tree.root, leafHash(entry)),
          `count=${count} index=${i}`,
        ).toBe(true);
      });
    }
  });

  it('rejects a proof for a leaf that is not in the tree', () => {
    const tree = buildScoreTree([VENUE_1, VENUE_2]);
    const forged = leafHash({ ...VENUE_1, scoreBps: 9_999 });
    expect(verifyProof(tree.proofFor(0), tree.root, forged)).toBe(false);
  });

  it('rejects a proof from a different epoch', () => {
    const current = buildScoreTree([VENUE_1, VENUE_2]);
    const older = buildScoreTree([
      { ...VENUE_1, asOf: ASOF - 3600 },
      { ...VENUE_2, asOf: ASOF - 3600 },
    ]);
    // This is the replay the contract also blocks by reading `asOf` from
    // storage rather than from the caller.
    expect(verifyProof(older.proofFor(0), current.root, leafHash(VENUE_1))).toBe(false);
  });

  it('looks a proof up by venue id', () => {
    const tree = buildScoreTree([VENUE_1, VENUE_2]);
    expect(tree.proofForVenue(2)).toEqual(tree.proofFor(1));
    expect(tree.proofForVenue(99)).toBeNull();
  });

  it('a single-leaf tree has an empty proof and the leaf as root', () => {
    const tree = buildScoreTree([VENUE_1]);
    expect(tree.root).toBe(LEAF_1);
    expect(tree.proofFor(0)).toEqual([]);
    expect(verifyProof([], tree.root, LEAF_1 as `0x${string}`)).toBe(true);
  });

  it('refuses a tree with mixed timestamps', () => {
    expect(() => buildScoreTree([VENUE_1, { ...VENUE_2, asOf: ASOF + 60 }])).toThrow(/same asOf/);
  });

  it('refuses an empty tree', () => {
    expect(() => buildScoreTree([])).toThrow(/no leaves/);
  });

  it('rejects an out-of-range leaf index', () => {
    const tree = buildScoreTree([VENUE_1, VENUE_2]);
    expect(() => tree.proofFor(5)).toThrow(/out of range/);
  });
});
