import type { Offer, Tier } from "@prisma/client";
import prisma from "../db.server";
import {
  toMetafield,
  normalizeTheme,
  normalizeOfferType,
  sanitizeGifts,
  sanitizeBundleItems,
  type OfferInput,
} from "../lib/offer-pricing";

// Re-export the client-safe pricing/validation logic so server callers have a
// single import surface.
export * from "../lib/offer-pricing";

export type OfferWithTiers = Offer & { tiers: Tier[] };

// Metafield the theme extension and discount function both read.
export const METAFIELD_NAMESPACE = "quantity_breaks";
export const METAFIELD_KEY = "config";

type AdminGraphql = (
  query: string,
  options?: { variables?: Record<string, unknown> },
) => Promise<Response>;

export function getOffers(shop: string) {
  return prisma.offer.findMany({
    where: { shop },
    orderBy: { updatedAt: "desc" },
    include: { tiers: { orderBy: { position: "asc" } } },
  });
}

export function getOffer(shop: string, id: string) {
  return prisma.offer.findFirst({
    where: { id, shop },
    include: { tiers: { orderBy: { position: "asc" } } },
  });
}

function tierCreateData(input: OfferInput) {
  return input.tiers.map((tier, index) => ({
    quantity: tier.quantity,
    getQuantity: tier.getQuantity ?? null,
    discountType: tier.discountType,
    discountValue: tier.discountValue,
    label: tier.label ?? null,
    subtitle: tier.subtitle ?? null,
    badgeText: tier.badgeText ?? null,
    highlight: tier.highlight,
    position: index,
    gifts: JSON.stringify(sanitizeGifts(tier.gifts)),
    bundleItems: JSON.stringify(sanitizeBundleItems(tier.bundleItems)),
  }));
}

export async function createOffer(shop: string, input: OfferInput) {
  return prisma.offer.create({
    data: {
      shop,
      title: input.title,
      type: normalizeOfferType(input.type),
      status: input.status,
      productId: input.productId ?? null,
      productTitle: input.productTitle ?? null,
      imageUrl: input.imageUrl ?? null,
      basePrice: input.basePrice,
      headerText: input.headerText ?? null,
      theme: JSON.stringify(normalizeTheme(input.theme)),
      tiers: { create: tierCreateData(input) },
    },
    include: { tiers: true },
  });
}

export async function updateOffer(shop: string, id: string, input: OfferInput) {
  const existing = await prisma.offer.findFirst({ where: { id, shop } });
  if (!existing) return null;

  await prisma.tier.deleteMany({ where: { offerId: id } });

  return prisma.offer.update({
    where: { id },
    data: {
      title: input.title,
      type: normalizeOfferType(input.type),
      status: input.status,
      productId: input.productId ?? null,
      productTitle: input.productTitle ?? null,
      imageUrl: input.imageUrl ?? null,
      basePrice: input.basePrice,
      headerText: input.headerText ?? null,
      theme: JSON.stringify(normalizeTheme(input.theme)),
      tiers: { create: tierCreateData(input) },
    },
    include: { tiers: true },
  });
}

// Update only an offer's status (used by the list's activate/deactivate
// toggle), returning the full offer with tiers so the metafield can be synced.
export async function setOfferStatus(
  shop: string,
  id: string,
  status: OfferInput["status"],
) {
  const existing = await prisma.offer.findFirst({ where: { id, shop } });
  if (!existing) return null;
  return prisma.offer.update({
    where: { id },
    data: { status },
    include: { tiers: { orderBy: { position: "asc" } } },
  });
}

export async function deleteOffer(shop: string, id: string) {
  const existing = await prisma.offer.findFirst({ where: { id, shop } });
  if (!existing) return false;
  await prisma.offer.delete({ where: { id } });
  return true;
}

// Create the metafield definition once so the value is readable on the
// storefront (theme extension) and well-typed in the admin. Safe to call
// repeatedly — an "already taken" error just means it exists.
async function ensureMetafieldDefinition(admin: AdminGraphql) {
  await admin(
    `#graphql
    mutation CreateQbDefinition($definition: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $definition) {
        createdDefinition { id }
        userErrors { code message }
      }
    }`,
    {
      variables: {
        definition: {
          name: "Quantity breaks config",
          namespace: METAFIELD_NAMESPACE,
          key: METAFIELD_KEY,
          type: "json",
          ownerType: "PRODUCT",
          access: { storefront: "PUBLIC_READ" },
        },
      },
    },
  );
}

// Mirror an offer to its product metafield. Active offers write the tier JSON;
// non-active or product-less offers clear it so the widget/discount disappear.
export async function syncOfferToMetafield(
  admin: AdminGraphql,
  offer: OfferWithTiers,
) {
  if (!offer.productId) return;

  await ensureMetafieldDefinition(admin);

  // The widget renders wherever the config lives, so write it to the offer's
  // product AND to every product included in a "complete the bundle" break.
  const bundleProductIds = offer.tiers.flatMap((tier) =>
    sanitizeBundleItems(tier.bundleItems ? JSON.parse(tier.bundleItems) : [])
      .map((item) => item.productId)
      .filter(Boolean),
  );
  const targets = Array.from(new Set([offer.productId, ...bundleProductIds]));

  if (offer.status !== "ACTIVE") {
    await admin(
      `#graphql
      mutation ClearQb($metafields: [MetafieldIdentifierInput!]!) {
        metafieldsDelete(metafields: $metafields) {
          deletedMetafields { key }
        }
      }`,
      {
        variables: {
          metafields: targets.map((ownerId) => ({
            ownerId,
            namespace: METAFIELD_NAMESPACE,
            key: METAFIELD_KEY,
          })),
        },
      },
    );
    return;
  }

  const value = JSON.stringify(
    toMetafield({
      title: offer.title,
      type: normalizeOfferType(offer.type),
      status: offer.status as OfferInput["status"],
      productId: offer.productId,
      productTitle: offer.productTitle,
      imageUrl: offer.imageUrl,
      basePrice: offer.basePrice,
      headerText: offer.headerText,
      theme: normalizeTheme(
        offer.theme ? JSON.parse(offer.theme) : null,
      ),
      tiers: offer.tiers.map((tier) => ({
        quantity: tier.quantity,
        getQuantity: tier.getQuantity,
        discountType: tier.discountType as OfferInput["tiers"][number]["discountType"],
        discountValue: tier.discountValue,
        label: tier.label,
        subtitle: tier.subtitle,
        badgeText: tier.badgeText,
        highlight: tier.highlight,
        gifts: sanitizeGifts(tier.gifts ? JSON.parse(tier.gifts) : []),
        bundleItems: sanitizeBundleItems(
          tier.bundleItems ? JSON.parse(tier.bundleItems) : [],
        ),
      })),
    }),
  );

  await admin(
    `#graphql
    mutation SetQb($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        metafields: targets.map((ownerId) => ({
          ownerId,
          namespace: METAFIELD_NAMESPACE,
          key: METAFIELD_KEY,
          type: "json",
          value,
        })),
      },
    },
  );
}

// The discount only applies once a DiscountAutomaticApp backed by our function
// exists in the shop. This creates it once (idempotently). It can only succeed
// after the function is registered via `shopify app dev` or `deploy`.
export async function ensureDiscountActivated(
  admin: AdminGraphql,
): Promise<{ activated: boolean; reason?: string }> {
  try {
    const fnRes = await admin(
      `#graphql
      query QbFunctions {
        shopifyFunctions(first: 50) {
          nodes { id title apiType }
        }
      }`,
    );
    const fnJson: any = await fnRes.json();
    const functions = fnJson?.data?.shopifyFunctions?.nodes ?? [];
    const fn = functions.find((f: any) => f.apiType === "product_discounts");
    if (!fn) {
      return {
        activated: false,
        reason:
          "Discount function isn't registered yet. Run the app with `npm run dev` (or deploy) so the function exists, then save an active offer again.",
      };
    }

    // `discountNodes(first: 100)` with no filter returns ALL discounts on the
    // shop (automatic, code, every app's) — not just ours. Once a shop has
    // more than 100 discounts total, an already-created "Quantity breaks"
    // discount can fall outside that first page and this check misses it,
    // so we'd try to create a second one and collide on the title. Filter by
    // title so this scales regardless of how many other discounts exist.
    const existingRes = await admin(
      `#graphql
      query QbDiscounts($query: String!) {
        discountNodes(first: 10, query: $query) {
          nodes {
            discount {
              __typename
              ... on DiscountAutomaticApp {
                appDiscountType { functionId }
              }
            }
          }
        }
      }`,
      { variables: { query: "title:'Quantity breaks'" } },
    );
    const existingJson: any = await existingRes.json();
    const nodes = existingJson?.data?.discountNodes?.nodes ?? [];
    const already = nodes.some(
      (n: any) => n?.discount?.appDiscountType?.functionId === fn.id,
    );
    if (already) return { activated: true };

    const createRes = await admin(
      `#graphql
      mutation QbCreateDiscount($discount: DiscountAutomaticAppInput!) {
        discountAutomaticAppCreate(automaticAppDiscount: $discount) {
          automaticAppDiscount { discountId }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          discount: {
            title: "Quantity breaks",
            functionId: fn.id,
            startsAt: new Date().toISOString(),
            combinesWith: {
              productDiscounts: true,
              orderDiscounts: false,
              shippingDiscounts: true,
            },
          },
        },
      },
    );
    const createJson: any = await createRes.json();
    const errors =
      createJson?.data?.discountAutomaticAppCreate?.userErrors ?? [];
    if (errors.length > 0) {
      // A title-uniqueness error means a "Quantity breaks" discount already
      // exists (the query above just didn't find it — a race with another
      // save, or a title collision from something outside our filter). Either
      // way the discount is active, so this isn't a real failure.
      const titleTaken = errors.some((e: any) =>
        /title.*unique|unique.*title/i.test(e.message ?? ""),
      );
      if (titleTaken) return { activated: true };

      return {
        activated: false,
        reason: errors.map((e: any) => e.message).join(", "),
      };
    }
    return { activated: true };
  } catch (error: any) {
    // Network/permission failures (e.g. missing read_discounts/write_discounts
    // scope) throw here. Surface a readable warning instead of crashing the
    // save — the offer itself is already persisted by the caller.
    const message =
      typeof error?.message === "string" ? error.message : String(error);
    const scopeHint = /access|scope|denied/i.test(message)
      ? " The app may need the read_discounts and write_discounts scopes — restart `npm run dev` so the updated scopes are granted, then save again."
      : "";
    return {
      activated: false,
      reason: `Couldn't activate the storefront discount automatically.${scopeHint}`,
    };
  }
}
