import * as z from "zod";
import { paymentPlansSchema } from "../env";

export const agentaosEnvSchema = paymentPlansSchema.extend({
  AGENTAOS_API_KEY: z.string({ error: "AGENTAOS_API_KEY is required" }),
  AGENTAOS_WEBHOOK_SECRET: z.string({
    error: "AGENTAOS_WEBHOOK_SECRET is required",
  }),
});
