/**
 * Merkle tree for `ScoreOracle` — spec §5.2.
 *
 * This is the off-chain half of a two-language contract. `ScoreOracle` will
 * only accept a proof whose leaf hashes byte-for-byte identically to
 * `ScoreOracle.leafHash`, so any drift here is silent: the keeper posts a root
 * the contract cannot verify against, every `rebalance` reverts with
 * `BadProof`, and the vault quietly stops rebalancing.
 *
 * Two encoding details carry that compatibility, and both are load-bearing:
 *
 *  1. **Leaves are hashed twice.** `keccak(bytes.concat(keccak(abi.encode(…))))`
 *     is the OpenZeppelin/merkletreejs convention. The second hash makes a leaf
 *     preimage impossible to confuse with an internal node, which is what stops
 *     a crafted proof passing off an internal node as a leaf.
 *
 *  2. **Pairs are sorted before hashing.** OpenZeppelin's `MerkleProof` hashes
 *     `min(a,b) || max(a,b)`, so the proof carries no left/right bits. The tree
 *     must sort identically or valid proofs will fail.
 *
 * `merkle.test.ts` pins both against values computed independently by `cast`
 * from the Solidity ABI encoding, so a change on either side fails the build
 * rather than the vault.
 */

import { encodeAbiParameters, keccak256, type Hex } from 'viem';

export type ScoreLeaf = {
  venueId: number;
  scoreBps: number;
  netApyBps: number;
  /** Unix seconds. Must equal the `asOf` posted with the root. */
  asOf: number;
};

/** Mirrors `ScoreOracle.leafHash(uint16,uint32,uint32,uint64)`. */
export function leafHash(leaf: ScoreLeaf): Hex {
  const encoded = encodeAbiParameters(
    [{ type: 'uint16' }, { type: 'uint32' }, { type: 'uint32' }, { type: 'uint64' }],
    [leaf.venueId, leaf.scoreBps, leaf.netApyBps, BigInt(leaf.asOf)],
  );
  return keccak256(keccak256(encoded));
}

/** OpenZeppelin's commutative pair hash: `keccak(min || max)`. */
export function hashPair(a: Hex, b: Hex): Hex {
  const [lo, hi] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return keccak256(`0x${lo.slice(2)}${hi.slice(2)}` as Hex);
}

function nextLevel(level: Hex[]): Hex[] {
  const parents: Hex[] = [];
  for (let i = 0; i < level.length; i += 2) {
    const left = level[i] as Hex;
    const right = level[i + 1];
    // An odd node is promoted unchanged rather than paired with itself.
    // Duplicating it would make two distinct leaf sets share a root.
    parents.push(right === undefined ? left : hashPair(left, right));
  }
  return parents;
}

export type ScoreTree = {
  root: Hex;
  leaves: Hex[];
  /** Proof for the leaf at `index`, ready to pass to `verifyScore`. */
  proofFor(index: number): Hex[];
  /** Proof for a venue id, or `null` if the venue is not in this tree. */
  proofForVenue(venueId: number): Hex[] | null;
};

export function buildScoreTree(entries: readonly ScoreLeaf[]): ScoreTree {
  if (entries.length === 0) {
    throw new RangeError('cannot build a score tree with no leaves');
  }

  const asOf = entries[0]?.asOf;
  if (entries.some((e) => e.asOf !== asOf)) {
    // The contract verifies against its own stored `asOf`, so a tree mixing
    // timestamps would produce leaves that can never all verify.
    throw new RangeError('every leaf must share the same asOf — the oracle stores one per epoch');
  }

  const leaves = entries.map(leafHash);

  const levels: Hex[][] = [leaves];
  let level = leaves;
  while (level.length > 1) {
    level = nextLevel(level);
    levels.push(level);
  }

  const proofFor = (index: number): Hex[] => {
    if (index < 0 || index >= leaves.length) {
      throw new RangeError(`leaf index ${index} out of range (${leaves.length} leaves)`);
    }
    const proof: Hex[] = [];
    let idx = index;
    for (let depth = 0; depth < levels.length - 1; depth += 1) {
      const current = levels[depth] as Hex[];
      const siblingIndex = idx ^ 1;
      const sibling = current[siblingIndex];
      // A promoted odd node has no sibling at this level, so contributes
      // nothing to the proof.
      if (sibling !== undefined) proof.push(sibling);
      idx = Math.floor(idx / 2);
    }
    return proof;
  };

  return {
    root: (levels[levels.length - 1] as Hex[])[0] as Hex,
    leaves,
    proofFor,
    proofForVenue(venueId: number) {
      const index = entries.findIndex((e) => e.venueId === venueId);
      return index === -1 ? null : proofFor(index);
    },
  };
}

/** Local re-verification, mirroring `MerkleProof.verifyCalldata`. */
export function verifyProof(proof: readonly Hex[], root: Hex, leaf: Hex): boolean {
  let computed = leaf;
  for (const sibling of proof) {
    computed = hashPair(computed, sibling);
  }
  return computed.toLowerCase() === root.toLowerCase();
}
