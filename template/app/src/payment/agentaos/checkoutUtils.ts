import { CHECKOUT_CANCELED_URL, CHECKOUT_SUCCESS_URL } from "../paths";
import { agentaosApi } from "./agentaosApi";

interface CreateAgentaosCheckoutSessionArgs {
  productId: string;
  userId: string;
  userEmail: string;
}

/**
 * Starts a checkout from an AgentaOS product (`linkId`). The user's id travels in
 * `metadata` and comes back on the `checkout.session.completed` webhook.
 */
export async function createAgentaosCheckoutSession({
  productId,
  userId,
  userEmail,
}: CreateAgentaosCheckoutSessionArgs) {
  const checkout = await agentaosApi.checkouts.create({
    linkId: productId,
    buyerEmail: userEmail,
    successUrl: CHECKOUT_SUCCESS_URL,
    cancelUrl: CHECKOUT_CANCELED_URL,
    metadata: { userId },
  });
  return { id: checkout.sessionId, url: checkout.checkoutUrl };
}
