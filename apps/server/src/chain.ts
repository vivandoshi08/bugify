import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { bazaarAbi, bountyStatusName, disputeStateName, outcomeIndex as outcomeIdx, outcomeName, type Outcome } from "@bugify/sdk";
import { env } from "./env.ts";

export const account = privateKeyToAccount(env.VERIFIER_KEY as Hex);
export const bazaar = env.BAZAAR_ADDRESS as Hex;
export const publicClient = createPublicClient({ chain: baseSepolia, transport: http(env.RPC_URL) });
export const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(env.RPC_URL) });

// bazaarAbi is typed as a plain `Abi`, so reads come back as unknown; the shapes below mirror IBazaar.sol.
type RawBounty = {
  buyer: Hex; manifestHash: Hex; controlHash: Hex; expiry: bigint; minBond: bigint; k: number;
  controlTierBps: number; escrow: bigint; pending: number; status: number; invariantCount: number;
};
type RawInvariant = { reward: bigint; slots: number; slotsUsed: number; cursor: number; commitCount: number };
type RawCommit = {
  bountyId: bigint; inv: number; seq: number; seller: Hex; commitment: Hex; bond: bigint; committedAt: bigint;
  outcome: number; hits: number; breaksControl: boolean; slotHeld: boolean; contentHash: Hex; traceHash: Hex;
  attestedAt: bigint; dispute: number; disputer: Hex; disputeBond: bigint; finalized: boolean;
};

const NOT_YET = new Set(["NoSuchBounty", "NoSuchCommit", "NoSuchInvariant"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Contract read with retry on "does not exist yet" reverts. The public RPC is load-balanced, so a read
 * issued right after a tx receipt can land on a node that has not seen that block; retry ~15 s before
 * treating the id as genuinely unknown.
 */
async function read<T>(functionName: string, args: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await publicClient.readContract({ address: bazaar, abi: bazaarAbi, functionName, args })) as T;
    } catch (err) {
      if (attempt < 10 && NOT_YET.has(revertName(err))) {
        await sleep(1500);
        continue;
      }
      throw err;
    }
  }
}

export async function getBounty(bountyId: bigint) {
  const b = await read<RawBounty>("getBounty", [bountyId]);
  return { ...b, status: bountyStatusName(b.status) };
}
export const getInvariant = (bountyId: bigint, inv: number) => read<RawInvariant>("getInvariant", [bountyId, inv]);
export async function getCommit(commitId: bigint) {
  const c = await read<RawCommit>("getCommit", [commitId]);
  return { ...c, outcome: outcomeName(c.outcome), dispute: disputeStateName(c.dispute) };
}
export const getChainId = () => publicClient.getChainId();

/** Decode a viem revert into the custom error name (e.g. "AlreadyFinalized"). */
export function revertName(err: unknown): string {
  if (err instanceof BaseError) {
    const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.reason ?? r.shortMessage;
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}

// ---- single tx queue: every send waits for the previous receipt, so nonces never race ----
let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const next = chain.then(job, job);
  chain = next.catch(() => {});
  return next;
}

async function send(functionName: string, args: unknown[]): Promise<Hex> {
  try {
    const { request } = await publicClient.simulateContract({
      address: bazaar, abi: bazaarAbi, functionName, args, account,
    });
    const hash = await walletClient.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted on chain (tx ${hash})`);
    return hash;
  } catch (err) {
    const name = revertName(err);
    throw new Error(`${functionName} failed: ${name}`, { cause: err });
  }
}

export const txQueue = {
  attest: (commitId: bigint, outcome: Outcome, hits: number, breaksControl: boolean, contentHash: Hex, salt: Hex, traceHash: Hex) =>
    enqueue(() => send("attest", [commitId, outcomeIdx(outcome), hits, breaksControl, contentHash, salt, traceHash])),
  voidBounty: (bountyId: bigint) => enqueue(() => send("voidBounty", [bountyId])),
  finalize: (commitId: bigint) => enqueue(() => send("finalize", [commitId])),
};
