'use node';

import { ConvexError, v } from 'convex/values';
import Stripe from 'stripe';

import { internal } from './_generated/api';
import { action, internalAction } from './_generated/server';

type PeriodItem = { price?: { id?: string } | null };
type PeriodField = 'current_period_start' | 'current_period_end';
type PlanItem = (items: PeriodItem[]) => PeriodItem | undefined;

// Typed like the removed field, which was also absent at runtime when Stripe omitted it.
function subscriptionPeriod(subscription: object, field: PeriodField, planItem?: PlanItem): number {
  const legacy: unknown = Reflect.get(subscription, field);
  if (typeof legacy === 'number') return legacy;
  const list: unknown = Reflect.get(subscription, 'items');
  const data: unknown = list && typeof list === 'object' ? Reflect.get(list, 'data') : undefined;
  const items = (Array.isArray(data) ? data : []).filter(
    (item): item is PeriodItem => typeof item === 'object' && item !== null,
  );
  const periods = new Set(items.map((item) => Reflect.get(item, field)));
  const chosen = periods.size === 1 ? items[0] : planItem?.(items);
  const value: unknown = chosen ? Reflect.get(chosen, field) : undefined;
  return (typeof value === 'number' ? value : undefined) as number;
}

function getSubscriptionPeriodEnd(subscription: object, planItem?: PlanItem): number {
  return subscriptionPeriod(subscription, 'current_period_end', planItem);
}

// Typed like the removed field under old stripe types, like the new location under new ones.
type InvoiceSubscription<T> = T extends { subscription: infer S }
  ? S
  : T extends { parent: infer P }
    ? NonNullable<P> extends { subscription_details: infer D }
      ? NonNullable<D> extends { subscription: infer S }
        ? S | null
        : string | null
      : string | null
    : string | null;

// The old top-level field when present (old-version payloads), otherwise the new location.
function getInvoiceSubscription<T extends object>(invoice: T): InvoiceSubscription<T> {
  const legacy: unknown = Reflect.get(invoice, 'subscription');
  const parent: unknown = Reflect.get(invoice, 'parent');
  const details: unknown =
    parent && typeof parent === 'object' ? Reflect.get(parent, 'subscription_details') : undefined;
  const moved: unknown =
    details && typeof details === 'object' ? Reflect.get(details, 'subscription') : undefined;
  return (legacy !== undefined ? legacy : (moved ?? null)) as InvoiceSubscription<T>;
}

type Metadata = {
  userId: string;
};

const stripe = new Stripe(process.env.STRIPE_KEY!, {
  apiVersion: '2026-09-30.endive',
});

export const checkout = action({
  args: {},
  handler: async (ctx) => {
    const user = await ctx.auth.getUserIdentity();

    console.log(user);
    if (!user) {
      throw new ConvexError('you must be logged in to subscribe');
    }

    if (!user.emailVerified) {
      throw new ConvexError('you must have a verified email to subscribe');
    }

    const session = await stripe.checkout.sessions.create({
      line_items: [{ price: process.env.SUBSCRIPTION_PRICE_ID!, quantity: 1 }],
      customer_email: user.email,
      metadata: {
        userId: user.subject,
      },
      mode: 'subscription',
      success_url: `${process.env.HOST_NAME}/success`,
      cancel_url: `${process.env.HOST_NAME}`,
    });

    return session;
  },
});

export const fulfill = internalAction({
  args: { signature: v.string(), payload: v.string() },
  handler: async (ctx, args) => {
    const webhookSecret = process.env.STRIPE_WEBHOOKS_SECRET!;
    try {
      const event = stripe.webhooks.constructEvent(
        args.payload,
        args.signature,
        webhookSecret,
      );

      console.log(event);

      const completedEvent = event.data.object as Stripe.Checkout.Session & {
        metadata: Metadata;
      };

      if (event.type === 'checkout.session.completed') {
        const subscription = await stripe.subscriptions.retrieve(
          completedEvent.subscription as string,
        );

        const userId = completedEvent.metadata.userId;

        console.log({
          type: event.type,
          userId,
        });

        await ctx.runMutation(internal.users.updateSubscription, {
          userId,
          subscriptionId: subscription.id,
          endsOn: (getSubscriptionPeriodEnd(subscription, (items) => items[0])) * 1000,
        });
      }

      if (event.type === 'invoice.payment_succeeded') {
        const subscription = await stripe.subscriptions.retrieve(
          (getInvoiceSubscription(completedEvent)) as string,
        );

        const subscriptionId = subscription.items.data[0]?.price.id;

        console.log({
          type: event.type,
          subscriptionId,
        });

        await ctx.runMutation(internal.users.updateSubscriptionBySubId, {
          subscriptionId,
          endsOn: (getSubscriptionPeriodEnd(subscription, (items) => items[0])) * 1000,
        });
      }

      return { success: true };
    } catch (err) {
      console.error(err);
      return { success: false, error: (err as { message: string }).message };
    }
  },
});
