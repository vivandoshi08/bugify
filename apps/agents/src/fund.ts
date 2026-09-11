// Prints platform / buyer / seller addresses and balances. `--send` tops up buyer and seller from PLATFORM_KEY.
import { RPC_URL, requireKey, flag, opt } from "./env.ts";
import { PLATFORM_ADDRESS, explorerTx } from "@bugify/sdk";
import { createPublicClient, createWalletClient, formatEther, http, parseEther, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const transport = http(RPC_URL);
const pub = createPublicClient({ chain: baseSepolia, transport });
const who: Array<[string, Address]> = [
  ["platform", PLATFORM_ADDRESS],
  ["buyer", privateKeyToAccount(requireKey("BUYER_KEY")).address],
  ["seller", privateKeyToAccount(requireKey("SELLER_KEY")).address],
];

async function show() {
  for (const [name, addr] of who) console.log(`${name.padEnd(8)} ${addr}  ${formatEther(await pub.getBalance({ address: addr }))} ETH`);
}
await show();

if (flag("send")) {
  const wallet = createWalletClient({ account: privateKeyToAccount(requireKey("PLATFORM_KEY")), chain: baseSepolia, transport });
  const amounts: Array<[string, Address, string]> = [
    ["buyer", who[1]![1], opt("buyer") ?? "0.00045"],
    ["seller", who[2]![1], opt("seller") ?? "0.0001"],
  ];
  for (const [name, to, eth] of amounts) {
    const hash = await wallet.sendTransaction({ to, value: parseEther(eth) });
    await pub.waitForTransactionReceipt({ hash });
    console.log(`sent ${eth} ETH → ${name}  ${explorerTx(hash)}`);
  }
  console.log();
  await show();
}
