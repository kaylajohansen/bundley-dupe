import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

/**
 * GDPR compliance webhook: customers/redact
 *
 * Shopify sends this when a customer's personal data must be erased (typically
 * 10 days after a redaction request, longer if the shop has legal/order
 * retention obligations). You must delete any customer-identifiable data.
 *
 * This app stores NO customer personal data, so there is nothing to erase. We
 * verify the request and acknowledge it. If you ever store data keyed to a
 * customer, delete it here using the payload's `customer.id` / `customer.email`
 * (and `orders_to_redact`).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const customerId = (payload as { customer?: { id?: number | string } })
    ?.customer?.id;
  console.log(
    `Received ${topic} for ${shop} (customer ${customerId}); no customer data stored — nothing to erase.`,
  );

  return new Response();
};
