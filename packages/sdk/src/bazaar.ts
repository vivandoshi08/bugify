// Agent-facing client: chain writes via viem, everything else via the server. See docs/ARCHITECTURE.md §8.
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
  parseEventLogs,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { bazaarAbi } from "./abi.ts";
import { BAZAAR_ADDRESS } from "./config.ts";
import { commitment, contentHash, manifestHash, randomSalt, ZERO_HASH } from "./hash.ts";
import { outcomeIndex, outcomeName, type Finding, type Hex, type Manifest, type Outcome, type PublicBounty, type ToolCall, type Transcript } from "./types.ts";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested, no network)
// ---------------------------------------------------------------------------

/** Escrow the buyer must send with postBounty: Σ reward_i × slots_i, in wei. */
export function totalValueWei(rewardsEth: string[], slots: number[]): bigint {
  if (rewardsEth.length !== slots.length || rewardsEth.length === 0) {
    throw new Error(`rewardsEth (${rewardsEth.length}) and slots (${slots.length}) must be equal, non-empty`);
  }
  let total = 0n;
  for (let i = 0; i < rewardsEth.length; i++) {
    const s = slots[i]!;
    if (!Number.isInteger(s) || s < 1 || s > 255) throw new Error(`slots[${i}] must be an integer in 1..255`);
    total += parseEther(rewardsEth[i]!) * BigInt(s);
  }
  return total;
}

export function buildTranscript(manifestHash: Hex, invariant: number, turns: string[]): Transcript {
  return { version: 1, manifestHash, invariant, turns: [...turns] };
}

/** Salt + commitment for a transcript. Keep the salt: it is revealed to the server. */
export function buildCommitment(t: Transcript, salt: Hex = randomSalt()): { salt: Hex; content: Hex; commitment: Hex } {
  const content = contentHash(t);
  return { salt, content, commitment: commitment(content, salt) };
}

export const findingsMessage = (bountyId: number | bigint, minute = Math.floor(Date.now() / 60000)) =>
  `bazaar:findings:${bountyId}:${minute}`;

export type DisputeOutcome = Extract<Outcome, "PASS" | "FAIL">;

/**
 * Who may call `dispute` on a commit, per IBazaar: the buyer on a PASS, the seller on a FAIL, nobody otherwise
 * (PASS_NO_SLOT, VOID, NONE, RECLAIMED are not disputable). Accepts the numeric enum from `getCommit` or a name.
 */
export function disputeSide(commit: { outcome: number | Outcome }): "buyer" | "seller" | null {
  const o = typeof commit.outcome === "number" ? outcomeName(commit.outcome) : commit.outcome;
  if (o === "PASS") return "buyer";
  if (o === "FAIL") return "seller";
  return null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BazaarOptions = { rpcUrl: string; privateKey: Hex; bazaarAddress?: Address; serverUrl: string };

export type PostBountyOptions = {
  rewardsEth: string[];
  slots: number[];
  expiryHours: number;
  minBondEth: string;
  k: number;
  control?: Manifest;
  controlTierBps?: number;
};

export type OnChainBounty = {
  buyer: Address;
  manifestHash: Hex;
  controlHash: Hex;
  expiry: bigint;
  minBond: bigint;
  k: number;
  controlTierBps: number;
  escrow: bigint;
  pending: number;
  status: number;
  invariantCount: number;
};

export type OnChainCommit = {
  bountyId: bigint;
  inv: number;
  seq: number;
  seller: Address;
  commitment: Hex;
  bond: bigint;
  committedAt: bigint;
  outcome: number;
  hits: number;
  breaksControl: boolean;
  slotHeld: boolean;
  contentHash: Hex;
  traceHash: Hex;
  attestedAt: bigint;
  dispute: number;
  disputer: Address;
  disputeBond: bigint;
  finalized: boolean;
};

export type TurnResult = { assistant: string; toolCalls: ToolCall[]; violations: number[] };
export type RevealResult = { outcome: Outcome; hits: number; breaksControl: boolean; attestTx: Hex };
export type SubmitResult = RevealResult & { commitId: bigint; commitTx: Hex; transcript: Transcript; salt: Hex };
export type DisputeResult = { txHash: Hex; bondWei: bigint };
export type ResolveResult = { txHash: Hex; outcome: Outcome; changed: boolean };
export type FinalizeResult = { txHash: Hex; paidWei: bigint };

export type Bazaar = ReturnType<typeof createBazaar>;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export function createBazaar(opts: BazaarOptions) {
  const account = privateKeyToAccount(opts.privateKey);
  const transport = http(opts.rpcUrl);
  const publicClient = createPublicClient({ chain: baseSepolia, transport });
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport });
  const address = opts.bazaarAddress ?? BAZAAR_ADDRESS;
  const serverUrl = opts.serverUrl.replace(/\/+$/, "");

  async function api<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
    const { timeoutMs = 30_000, ...rest } = init;
    const res = await fetch(`${serverUrl}${path}`, {
      ...rest,
      headers: { "content-type": "application/json", ...(rest.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${rest.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 500)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  const read = <T>(functionName: string, args: unknown[] = []) =>
    publicClient.readContract({ address, abi: bazaarAbi, functionName, args }) as Promise<T>;

  async function write(functionName: string, args: unknown[], value?: bigint) {
    const hash = await walletClient.writeContract({ address, abi: bazaarAbi, functionName, args, value, account, chain: baseSepolia });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
    return { hash, receipt };
  }

  function eventArgs<T>(logs: Parameters<typeof parseEventLogs>[0]["logs"], eventName: string): T {
    const [log] = parseEventLogs({ abi: bazaarAbi, eventName, logs });
    if (!log) throw new Error(`event ${eventName} not found in receipt`);
    return (log as unknown as { args: T }).args;
  }

  async function registerManifest(m: Manifest): Promise<Hex> {
    const local = manifestHash(m);
    const { manifestHash: remote } = await api<{ manifestHash: Hex }>("/manifests", { method: "POST", body: JSON.stringify(m) });
    if (remote?.toLowerCase() !== local.toLowerCase()) {
      throw new Error(`manifest hash mismatch: local ${local} vs server ${remote}. Canonicalization differs between SDK and server.`);
    }
    return local;
  }

  const getBounty = (bountyId: number | bigint) => read<OnChainBounty>("getBounty", [BigInt(bountyId)]);
  const getCommit = (commitId: number | bigint) => read<OnChainCommit>("getCommit", [BigInt(commitId)]);

  return {
    address: account.address,
    bazaarAddress: address,
    publicClient,
    walletClient,

    async balance(): Promise<string> {
      return formatEther(await publicClient.getBalance({ address: account.address }));
    },

    async postBounty(manifest: Manifest, o: PostBountyOptions) {
      const mh = await registerManifest(manifest);
      const ch = o.control ? await registerManifest(o.control) : ZERO_HASH;
      const rewards = o.rewardsEth.map((r) => parseEther(r));
      const value = totalValueWei(o.rewardsEth, o.slots);
      const expiry = BigInt(Math.floor(Date.now() / 1000) + Math.round(o.expiryHours * 3600));
      const { hash, receipt } = await write(
        "postBounty",
        [mh, ch, rewards, o.slots, expiry, parseEther(o.minBondEth), o.k, o.controlTierBps ?? 0],
        value,
      );
      const { bountyId } = eventArgs<{ bountyId: bigint }>(receipt.logs, "BountyPosted");
      return { bountyId, manifestHash: mh, txHash: hash };
    },

    listBounties: () => api<PublicBounty[]>("/bounties"),
    getBountyPublic: (bountyId: number | bigint) => api<PublicBounty>(`/bounties/${bountyId}`),
    getBounty,
    getCommit,

    async openSession(bountyId: number | bigint) {
      const { sessionId } = await api<{ sessionId: string }>(`/bounties/${bountyId}/sessions`, { method: "POST", body: "{}" });
      return {
        sessionId,
        say: (text: string) =>
          api<TurnResult>(`/sessions/${sessionId}/turn`, { method: "POST", body: JSON.stringify({ text }), timeoutMs: 120_000 }),
      };
    },

    async submitFinding(bountyId: number | bigint, invariant: number, turns: string[]): Promise<SubmitResult> {
      const b = await getBounty(bountyId);
      const transcript = buildTranscript(b.manifestHash, invariant, turns);
      const { salt, commitment: c } = buildCommitment(transcript);
      const { hash: commitTx, receipt } = await write("commit", [BigInt(bountyId), invariant, c], b.minBond);
      const { commitId } = eventArgs<{ commitId: bigint }>(receipt.logs, "Committed");
      const r = await api<{ outcome: Outcome | number; hits: number; breaksControl: boolean; attestTx: Hex }>(
        `/commits/${commitId}/reveal`,
        { method: "POST", body: JSON.stringify({ transcript, salt }), timeoutMs: 180_000 },
      );
      const outcome = typeof r.outcome === "number" ? outcomeName(r.outcome) : r.outcome;
      return { commitId, commitTx, transcript, salt, outcome, hits: r.hits, breaksControl: r.breaksControl, attestTx: r.attestTx };
    },

    async settle(commitId: number | bigint, opts: { pollMs?: number; onWait?: (secondsLeft: number) => void } = {}) {
      const window = await read<bigint>("disputeWindow");
      for (;;) {
        const c = await getCommit(commitId);
        if (c.finalized) throw new Error(`commit ${commitId} already finalized`);
        if (c.attestedAt > 0n) {
          const ready = c.attestedAt + window;
          const now = BigInt(Math.floor(Date.now() / 1000));
          if (ready <= now) break;
          opts.onWait?.(Number(ready - now));
        }
        await new Promise((r) => setTimeout(r, opts.pollMs ?? 3000));
      }
      const { hash, receipt } = await write("finalize", [BigInt(commitId)]);
      const { paidToSeller } = eventArgs<{ paidToSeller: bigint }>(receipt.logs, "Finalized");
      return { finalizeTx: hash, paidWei: paidToSeller };
    },

    // --- disputes (docs/CONTRACTS.md §4 dispute / resolve / finalize) ---

    /** Contract config reads used by the dispute scripts. */
    disputeBond: () => read<bigint>("disputeBond"),
    disputeWindow: () => read<bigint>("disputeWindow"),
    arbiter: () => read<Address>("arbiter"),
    commitCount: () => read<bigint>("commitCount"),

    /**
     * Open a dispute on an attested commit. Caller must be the bounty's buyer (outcome PASS) or the commit's
     * seller (outcome FAIL) and inside the dispute window. Sends exactly `disputeBond()` as the bond.
     */
    async dispute(commitId: number | bigint): Promise<DisputeResult> {
      const bond = await read<bigint>("disputeBond");
      const { hash, receipt } = await write("dispute", [BigInt(commitId)], bond);
      const { bond: bondWei } = eventArgs<{ disputer: Address; bond: bigint }>(receipt.logs, "Disputed");
      return { txHash: hash, bondWei };
    },

    /** Arbiter only: rule on an OPEN dispute. `changed` is true when the stored outcome flipped. */
    async resolve(commitId: number | bigint, outcome: DisputeOutcome): Promise<ResolveResult> {
      if (outcome !== "PASS" && outcome !== "FAIL") throw new Error(`resolve outcome must be PASS or FAIL, got ${outcome}`);
      const { hash, receipt } = await write("resolve", [BigInt(commitId), outcomeIndex(outcome)]);
      const ev = eventArgs<{ outcome: number; changed: boolean }>(receipt.logs, "Resolved");
      return { txHash: hash, outcome: outcomeName(Number(ev.outcome)), changed: ev.changed };
    },

    /**
     * Finalize without waiting. Use after a dispute is RESOLVED (finalize is allowed immediately then) or once
     * the window has elapsed; otherwise the contract reverts with WindowOpen / DisputeOpen. See `settle` for the
     * polling variant.
     */
    async finalize(commitId: number | bigint): Promise<FinalizeResult> {
      const { hash, receipt } = await write("finalize", [BigInt(commitId)]);
      const { paidToSeller } = eventArgs<{ paidToSeller: bigint }>(receipt.logs, "Finalized");
      return { txHash: hash, paidWei: paidToSeller };
    },

    async getFindings(bountyId: number | bigint): Promise<Finding[]> {
      const signature = await walletClient.signMessage({ account, message: findingsMessage(bountyId) });
      return api<Finding[]>(`/bounties/${bountyId}/findings`, { headers: { "X-Address": account.address, "X-Signature": signature } });
    },

    async expire(bountyId: number | bigint) {
      const { hash } = await write("expire", [BigInt(bountyId)]);
      return { txHash: hash };
    },
  };
}
