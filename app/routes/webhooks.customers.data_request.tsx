import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

/**
 * GDPR compliance webhook: customers/data_request
 *
 * Shopify sends this when a customer (via a merchant) requests the data your
 * app has stored about them. You have 30 days to provide it to the merchant.
 *
 * This app stores NO customer personal data — `Offer`/`Tier` are product- and
 * shop-scoped, and `Session` holds only merchant/shop auth data. There is
 * therefore nothing to compile or return. We verify the request and
 * acknowledge it. If you ever start storing customer-identifiable data, gather
 * it here (keyed by the payload's `customer.id` / `customer.email`) and deliver
 * it to the merchant out-of-band.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const customerId = (payload as { customer?: { id?: number | string } })
    ?.customer?.id;
  console.log(
    `Received ${topic} for ${shop} (customer ${customerId}); no customer data stored — nothing to return.`,
  );

  return new Response();
};
