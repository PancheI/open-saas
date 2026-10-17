import { AgentaOS } from "@agentaos/pay";
import { env } from "wasp/server";

/**
 * A key that starts with `sk_test_` works in test mode, `sk_live_` in live mode.
 */
export const agentaosApi = new AgentaOS(env.AGENTAOS_API_KEY);
