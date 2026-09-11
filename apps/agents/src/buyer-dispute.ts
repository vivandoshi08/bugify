// Buyer disputes a PASS (docs/contract-flows.html "Buyer disputes a PASS"): --commit <id> [--dry]
// Prints the commit, posts the dispute bond with BUYER_KEY, waits for the arbiter, then finalizes immediately.
import { runPartyDispute } from "./dispute-lib.ts";

await runPartyDispute("buyer");
