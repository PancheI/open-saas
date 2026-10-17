import type { PaymentProcessorClient } from "../paymentProcessorClient";
import { redirectToCheckout } from "../redirectToCheckout";

export const agentaosPaymentProcessorClient: PaymentProcessorClient = {
  id: "agentaos",
  openCheckout: redirectToCheckout,
};
