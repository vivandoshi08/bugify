import bazaarJson from "../abi/Bazaar.json" with { type: "json" };
import singleVerifierJson from "../abi/SingleVerifier.json" with { type: "json" };
import type { Abi } from "viem";

export const bazaarAbi = bazaarJson as Abi;
export const singleVerifierAbi = singleVerifierJson as Abi;
