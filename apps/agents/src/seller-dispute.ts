// Seller disputes a FAIL (docs/contract-flows.html "Seller disputes a FAIL"): --commit <id> [--dry]
// Prints the commit, posts the dispute bond with SELLER_KEY, waits for the arbiter, then finalizes immediately.
import { runPartyDispute } from "./dispute-lib.ts";

await runPartyDispute("seller");
