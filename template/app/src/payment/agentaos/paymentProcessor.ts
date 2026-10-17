import type {
  CreateCheckoutSessionArgs,
  FetchCustomerPortalUrlArgs,
  PaymentProcessor,
} from "../paymentProcessor";
import { getPaymentProcessorPlanId } from "../paymentProcessorPlans";
import { updateUserPaymentProcessorUserId } from "../user";
import { agentaosApi } from "./agentaosApi";
import { createAgentaosCheckoutSession } from "./checkoutUtils";
import {
  agentaosMiddlewareConfigFn,
  agentaosWebhook,
  toAgentaosCustomerId,
} from "./webhook";

export const agentaosPaymentProcessor: PaymentProcessor = {
  id: "agentaos",
  createCheckoutSession: async ({
    userId,
    userEmail,
    paymentPlan,
    prismaUserDelegate,
  }: CreateCheckoutSessionArgs) => {
    // AgentaOS subscription events identify the buyer by email, so the user's
    // email is their AgentaOS customer id. The checkout is prefilled with it.
    await updateUserPaymentProcessorUserId(
      { userId, paymentProcessorUserId: toAgentaosCustomerId(userEmail) },
      prismaUserDelegate,
    );
    const session = await createAgentaosCheckoutSession({
      productId: getPaymentProcessorPlanId(paymentPlan),
      userId,
      userEmail,
    });
    return { session: { kind: "redirect", ...session } };
  },
  fetchCustomerPortalUrl: async (_args: FetchCustomerPortalUrlArgs) => {
    // AgentaOS has no hosted customer portal. Buyers manage a subscription from the
    // links in their receipt emails; you can also cancel or change plans server-side
    // with `agentaosApi.subscriptions`.
    return null;
  },
  webhook: agentaosWebhook,
  webhookMiddlewareConfigFn: agentaosMiddlewareConfigFn,
  fetchTotalRevenue: async () => {
    let totalRevenue = 0;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const page = await agentaosApi.invoices.list({
        status: "issued",
        limit: 100,
        offset,
      });
      for (const invoice of page.items) {
        totalRevenue += invoice.fiatAmount ?? invoice.amount;
      }
      hasMore = page.hasMore;
      offset += page.items.length;
    }

    // Invoice amounts are already in your main currency unit (e.g. euros, not cents).
    return totalRevenue;
  },
};
