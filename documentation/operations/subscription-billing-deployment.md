# Deploying subscription billing (migration 0018) safely

For ADR 0010. Do this in order. Nothing here makes any organization pay until step 7.

## 0. Before anything
- Confirm with Stripe that the account is eligible for Stripe Billing in your country and business type, and that taking recurring card payments for this business model is allowed. This was not verified by the engineering work.
- Confirm the commercial assumptions (ASSUMPTIONS #67-77) with the business: prices, trial days, grace days, annual discount.
- Take and test a database backup. Migration 0018 only adds tables and one column (`organizations.billing_mode`, default `exempt`); it does not rewrite large tables.
- `npm run typecheck`, `npm test`, `npm run build` pass on the build you deploy.

## 1. Migrate with billing OFF
Deploy with `BILLING_SUBSCRIPTIONS_ENABLED` unset or `false`. Every organization is `exempt`; checkout returns 503; behaviour is unchanged. Usage counters are still recorded for gated routes (talent searches, submissions), which gives real numbers for validating the limits.

## 2. Stripe test mode
1. In the Stripe **test** dashboard create a Product and a recurring Price for each plan you will sell. Prices must match `subscription_plans.price_amount` (USD, cents).
2. Configure the Customer Portal: allow payment-method updates, invoice history, cancellation at period end, and plan switching among the prices you created.
3. Add a webhook endpoint `https://<api-host>/api/v1/billing/webhooks/stripe` with events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. Copy the signing secret.
4. Set on the API server only: `STRIPE_SECRET_KEY` (restricted key preferred), `STRIPE_WEBHOOK_SECRET`, `BILLING_SUBSCRIPTIONS_ENABLED=true`, optionally `BILLING_GRACE_DAYS`. Never put these in a web/admin build variable.
5. In the admin app (Subscriptions), edit each plan: attach its `price_…` id, set Active/Public. Annual rows are seeded inactive on purpose.

## 3. Verify in test mode (checklist)
- Public `GET /billing/plans` shows only active public plans.
- An internal test organization's owner starts checkout, pays with Stripe test card 4242…, and the subscription appears (the success page waits for the webhook).
- Use `stripe trigger` or the dashboard to send: a failed payment (org becomes past-due, owner notified, grace date set), a recovery, a cancel-at-period-end from the portal, an immediate cancellation.
- Resend the same event from the dashboard: the response is 200 and nothing changes twice.
- Break the signing secret temporarily: Stripe shows 400s; nothing is recorded. Restore it.
- Stop the API for a minute during an event, then let Stripe retry: the state converges. Use **Re-sync from Stripe** on the organization if it does not.
- A user from organization B cannot read or change organization A's billing (404).

## 4. Internal organizations
In Subscriptions → Organization billing controls, set your own test organizations to **Start gating**. Confirm talent search, locations, analytics and match runs stop without a plan and work with one; confirm limits and the upgrade message.

## 5. Founding customers
Create the customer's subscription through checkout. For discounts use **Approve discount** (founding_customer); it applies at their next checkout. For a custom contract, create a private plan, create the subscription in the Stripe dashboard with metadata `organization_id`, link the Stripe customer to the organization (`PUT /admin/billing/organizations/:orgId/customer`), then re-sync. Only then set the organization to gated.

## 6. Production keys
Repeat step 2 with live-mode objects and secrets. The API refuses to start in production until the email and file-storage adapters exist (existing guard); billing does not change that.

## 7. Expand gradually
Gate organizations in small batches. Watch `billing_events` for `failed` rows (error codes: `unknown_price` - attach the price then wait for Stripe's retry; `duplicate_subscription` - a customer paid twice, refund one in Stripe; `organization_mismatch` - investigate) and the audit log for `billing.*` actions.

## Rolling back
Set `BILLING_SUBSCRIPTIONS_ENABLED=false` and redeploy: all gating and checkout stop at once, data is kept. To release one organization, set it to **Stop gating**. Do not drop 0018's tables.
