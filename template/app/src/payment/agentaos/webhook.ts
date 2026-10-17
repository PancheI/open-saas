import type { WebhookEvent } from "@agentaos/pay";
import express from "express";
import { env, type MiddlewareConfigFn, type PrismaClient } from "wasp/server";
import type { PaymentsWebhook } from "wasp/server/api";
import { assertUnreachable } from "../../shared/utils";
import { UnhandledWebhookEventError } from "../errors";
import { getPaymentPlanIdByPaymentProcessorPlanId } from "../paymentProcessorPlans";
import {
  SubscriptionStatus as OpenSaasSubscriptionStatus,
  paymentPlans,
} from "../plans";
import { processWebhookEventOnce } from "../processedWebhookEvent";
import { updateUserSubscription } from "../user";
import { agentaosApi } from "./agentaosApi";

type CheckoutCompletedEvent = Extract<
  WebhookEvent,
  { type: "checkout.session.completed" }
>;
type SubscriptionEvent = Extract<
  WebhookEvent,
  {
    type:
      | "subscription.created"
      | "subscription.renewed"
      | "subscription.updated"
      | "subscription.payment_failed"
      | "subscription.canceled";
  }
>;

/**
 * The user's AgentaOS customer id: their email, lower-cased.
 */
export function toAgentaosCustomerId(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * AgentaOS signs the raw request body, so it must not be parsed as JSON first.
 */
export const agentaosMiddlewareConfigFn: MiddlewareConfigFn = (
  middlewareConfig,
) => {
  middlewareConfig.delete("express.json");
  middlewareConfig.set(
    "express.raw",
    express.raw({ type: "application/json" }),
  );
  return middlewareConfig;
};

export const agentaosWebhook: PaymentsWebhook = async (
  request,
  response,
  context,
) => {
  const userDelegate = context.entities.User;
  try {
    const event = agentaosApi.webhooks.verify(
      request.body,
      request.get("x-agentaos-signature") ?? "",
      env.AGENTAOS_WEBHOOK_SECRET,
    );

    switch (event.type) {
      case "checkout.session.completed":
        // A retried delivery carries the same checkout session, so it is the event id.
        await processWebhookEventOnce(
          {
            paymentProcessorEventId: `${event.type}:${event.data.sessionId}`,
            eventType: event.type,
          },
          context.entities.ProcessedWebhookEvent,
          () => handleCheckoutCompleted(event, userDelegate),
        );
        break;
      case "subscription.created":
      case "subscription.renewed":
      case "subscription.updated":
      case "subscription.payment_failed":
      case "subscription.canceled":
        // These only set absolute values, so handling one twice is harmless.
        await handleSubscriptionEvent(event, userDelegate);
        break;
      default:
        throw new UnhandledWebhookEventError(event.type);
    }

    return response.status(200).json({ received: true });
  } catch (error) {
    if (error instanceof UnhandledWebhookEventError) {
      console.info("Unhandled AgentaOS webhook event: ", error.message);
      // Return a 2XX status code, otherwise AgentaOS keeps retrying the event.
      return response.status(200).json({ error: error.message });
    }

    console.error("AgentaOS webhook error: ", error);
    return response
      .status(400)
      .json({ error: "Error processing AgentaOS webhook event" });
  }
};

async function handleCheckoutCompleted(
  { data: checkout }: CheckoutCompletedEvent,
  userDelegate: PrismaClient["user"],
): Promise<void> {
  const userId = checkout.metadata.userId;
  if (typeof userId !== "string") {
    throw new Error(`Checkout ${checkout.sessionId} has no userId in metadata`);
  }

  const paymentPlanId = getPaymentPlanIdByPaymentProcessorPlanId(
    checkout.linkId,
  );
  const plan = paymentPlans[paymentPlanId];

  switch (plan.effect.kind) {
    case "credits":
      await userDelegate.update({
        where: { id: userId },
        data: {
          credits: { increment: plan.effect.amount },
          datePaid: new Date(),
        },
      });
      break;
    case "subscription":
      await userDelegate.update({
        where: { id: userId },
        data: {
          subscriptionPlan: paymentPlanId,
          subscriptionStatus: OpenSaasSubscriptionStatus.Active,
          datePaid: new Date(),
        },
      });
      break;
    default:
      assertUnreachable(plan.effect);
  }
}

async function handleSubscriptionEvent(
  event: SubscriptionEvent,
  userDelegate: PrismaClient["user"],
): Promise<void> {
  const { data: subscription } = event;
  if (!subscription.customerEmail) {
    console.warn(`Subscription ${subscription.id} has no customer email`);
    return;
  }

  const subscriptionStatus = getOpenSaasSubscriptionStatus(event);
  if (!subscriptionStatus) {
    return;
  }

  const paymentProcessorUserId = toAgentaosCustomerId(
    subscription.customerEmail,
  );
  const user = await userDelegate.findUnique({
    where: { paymentProcessorUserId },
    select: { id: true },
  });
  if (!user) {
    // The buyer changed the prefilled email at checkout. Access was already
    // granted from `checkout.session.completed`; match this email by hand.
    console.warn(
      `No user with AgentaOS customer id ${paymentProcessorUserId} for subscription ${subscription.id}`,
    );
    return;
  }

  await updateUserSubscription(
    {
      paymentProcessorUserId,
      subscriptionStatus,
      paymentPlanId: getPaymentPlanIdByPaymentProcessorPlanId(
        subscription.linkId,
      ),
      ...(event.type === "subscription.renewed" && { datePaid: new Date() }),
    },
    userDelegate,
  );
}

function getOpenSaasSubscriptionStatus({
  type,
  data: subscription,
}: SubscriptionEvent): OpenSaasSubscriptionStatus | undefined {
  if (type === "subscription.canceled") {
    return OpenSaasSubscriptionStatus.Deleted;
  }

  const agentaosToOpenSaasSubscriptionStatus: Record<
    string,
    OpenSaasSubscriptionStatus | undefined
  > = {
    trialing: OpenSaasSubscriptionStatus.Active,
    active: OpenSaasSubscriptionStatus.Active,
    past_due: OpenSaasSubscriptionStatus.PastDue,
    canceled: OpenSaasSubscriptionStatus.Deleted,
    unpaid: OpenSaasSubscriptionStatus.Deleted,
    incomplete_expired: OpenSaasSubscriptionStatus.Deleted,
  };
  const subscriptionStatus =
    agentaosToOpenSaasSubscriptionStatus[subscription.status];

  if (
    subscriptionStatus === OpenSaasSubscriptionStatus.Active &&
    subscription.cancelAtPeriodEnd
  ) {
    return OpenSaasSubscriptionStatus.CancelAtPeriodEnd;
  }
  return subscriptionStatus;
}
