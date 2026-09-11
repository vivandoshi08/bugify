// The only place bytes are defined. Buyer, seller, server and contract must all agree on these.
import { encodePacked, keccak256, toBytes } from "viem";
import type { Hex, Manifest, Trace, Transcript } from "./types.ts";

/**
 * Deterministic JSON: object keys sorted recursively, arrays in order, no whitespace,
 * `undefined` values dropped (same as JSON.stringify). Equivalent to json-stable-stringify defaults.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

export const hashJson = (value: unknown): Hex => keccak256(toBytes(stableStringify(value)));

export const manifestHash = (m: Manifest): Hex => hashJson(m);
export const contentHash = (t: Transcript): Hex => hashJson(t);
export const traceHash = (tr: Trace[]): Hex => hashJson(tr);

/** == Solidity keccak256(abi.encodePacked(bytes32 contentHash, bytes32 salt)) */
export const commitment = (content: Hex, salt: Hex): Hex =>
  keccak256(encodePacked(["bytes32", "bytes32"], [content, salt]));

export function randomSalt(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export const ZERO_HASH: Hex = `0x${"0".repeat(64)}`;
