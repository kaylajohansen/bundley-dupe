// @ts-check
import { DiscountApplicationStrategy } from "../generated/api";

/**
 * @typedef {import("../generated/api").RunInput} RunInput
 * @typedef {import("../generated/api").FunctionRunResult} FunctionRunResult
 * @typedef {import("../generated/api").Target} Target
 */

/**
 * @type {FunctionRunResult}
 */
const EMPTY_DISCOUNT = {
  discountApplicationStrategy: DiscountApplicationStrategy.All,
  discounts: [],
};

/**
 * Buy X, get Y across a product's cart lines. The bundle's units may be split
 * over several variant lines (mix-and-match) at different prices, so we expand
 * the lines into individual units, pick the cheapest Y units (Shopify's
 * standard BXGY rule), and discount exactly those units via per-line quantity
 * targets — precise even when variants differ in price.
 *
 * @param {any} config
 * @param {number} totalQty  combined quantity of the product across its lines
 * @param {{ id: string, quantity: number, price: number }[]} lines
 */
function bxgyDiscount(config, totalQty, lines) {
  const tiers = (config.tiers || [])
    .filter((t) => t && typeof t.quantity === "number")
    .map((t) => {
      const y = typeof t.getQuantity === "number" ? t.getQuantity : 0;
      return {
        x: t.quantity,
        y,
        total: t.quantity + y,
        type: t.discountType,
        value: t.discountValue,
        badge: t.badgeText,
      };
    })
    .filter((t) => t.y > 0 && t.value > 0)
    .sort((a, b) => b.total - a.total);

  // Prefer an exact total; otherwise the best tier the total still meets.
  const tier =
    tiers.find((t) => t.total === totalQty) ||
    tiers.find((t) => totalQty >= t.total);
  if (!tier) return null;

  // Expand lines into individual units, then take the cheapest Y as the reward.
  const units = [];
  for (const line of lines) {
    for (let i = 0; i < line.quantity; i++) {
      units.push({ id: line.id, price: line.price });
    }
  }
  units.sort((a, b) => a.price - b.price);
  const rewarded = units.slice(0, tier.y);
  if (rewarded.length === 0) return null;

  // Count how many rewarded units fall on each line → quantity-scoped targets.
  const perLine = new Map();
  for (const u of rewarded) perLine.set(u.id, (perLine.get(u.id) || 0) + 1);
  /** @type {Target[]} */
  const targets = [];
  perLine.forEach((quantity, id) => {
    targets.push({ cartLine: { id, quantity } });
  });

  const message =
    (config.theme && config.theme.discountName) ||
    tier.badge ||
    `Buy ${tier.x}, get ${tier.y} on ${config.title || "this item"}`;

  if (tier.type === "PERCENT") {
    let pct = tier.value;
    if (pct <= 0) return null;
    if (pct > 100) pct = 100;
    return {
      message,
      targets,
      value: { percentage: { value: String(pct) } },
    };
  }

  if (tier.type === "FIXED_PER_UNIT") {
    if (!(tier.value > 0)) return null;
    return {
      message,
      targets,
      value: {
        fixedAmount: {
          amount: String(tier.value),
          appliesToEachItem: true,
        },
      },
    };
  }

  return null;
}

// Expand lines into individual units and take the cheapest `count` of them,
// grouped back into per-line quantity targets. Shared by BXGY and bundle
// discounting, which both need to discount an exact sub-quantity of a line.
/**
 * @param {{ id: string, quantity: number, price: number }[]} lines
 * @param {number} count
 */
function unitsToLineTargets(lines, count) {
  const units = [];
  for (const line of lines) {
    for (let i = 0; i < line.quantity; i++) {
      units.push({ id: line.id, price: line.price });
    }
  }
  units.sort((a, b) => a.price - b.price);
  const rewarded = units.slice(0, count);
  const perLine = new Map();
  for (const u of rewarded) perLine.set(u.id, (perLine.get(u.id) || 0) + 1);
  /** @type {Target[]} */
  const targets = [];
  perLine.forEach((quantity, id) => targets.push({ cartLine: { id, quantity } }));
  return targets;
}

// How many complete bundle sets are satisfied: the anchor product's total
// (in `tier.quantity`-sized chunks) capped by however many sets each bundle
// item's own cart quantity can supply.
/**
 * @param {any} tier
 * @param {number} anchorTotal
 * @param {Map<string, { config: any, total: number, lines: any[] }>} groups
 */
function bundleSetsCompleted(tier, anchorTotal, groups) {
  const anchorNeed = Math.max(1, Math.floor(tier.quantity) || 1);
  let sets = Math.floor(anchorTotal / anchorNeed);
  for (const item of tier.bundleItems || []) {
    if (!item || !item.productId) continue;
    const need = Math.max(1, Math.floor(item.quantity) || 1);
    const group = groups.get(item.productId);
    const have = group ? group.total : 0;
    sets = Math.min(sets, Math.floor(have / need));
  }
  return Math.max(0, sets);
}

/**
 * "Complete the bundle": the anchor product's tier is discounted together
 * with every configured bundle item, as one combined percentage/fixed-amount
 * discount, once every product required by the bundle is present in the
 * needed quantity.
 *
 * @param {any} config
 * @param {string} anchorProductId
 * @param {Map<string, { config: any, total: number, lines: any[] }>} groups
 */
function bundleDiscount(config, anchorProductId, groups) {
  const anchorGroup = groups.get(anchorProductId);
  if (!anchorGroup) return null;

  const tiers = (config.tiers || []).filter(
    (t) => t && Array.isArray(t.bundleItems) && t.bundleItems.length > 0,
  );

  for (const tier of tiers) {
    if (!(tier.discountValue > 0)) continue;
    const sets = bundleSetsCompleted(tier, anchorGroup.total, groups);
    if (sets < 1) continue;

    const anchorNeed = Math.max(1, Math.floor(tier.quantity) || 1);
    const targets = unitsToLineTargets(anchorGroup.lines, anchorNeed * sets);
    for (const item of tier.bundleItems) {
      const group = groups.get(item.productId);
      if (!group) continue;
      const need = Math.max(1, Math.floor(item.quantity) || 1) * sets;
      targets.push(...unitsToLineTargets(group.lines, need));
    }
    if (targets.length === 0) continue;

    const message =
      (config.theme && config.theme.discountName) ||
      tier.badgeText ||
      "Complete the bundle";

    if (tier.discountType === "PERCENT") {
      let pct = tier.discountValue;
      if (pct > 100) pct = 100;
      return { message, targets, value: { percentage: { value: String(pct) } } };
    }

    if (tier.discountType === "FIXED_PER_UNIT") {
      return {
        message,
        targets,
        value: {
          fixedAmount: { amount: String(tier.discountValue), appliesToEachItem: true },
        },
      };
    }
  }

  return null;
}

/**
 * Build the quantity-break discount for a product, from its combined quantity
 * across all of its cart lines, applied to every one of those lines.
 *
 * @param {any} config
 * @param {number} totalQty
 * @param {Target[]} targets
 */
function quantityBreakDiscount(config, totalQty, targets) {
  const tiers = (config.tiers || [])
    .filter(
      (tier) =>
        tier &&
        typeof tier.quantity === "number" &&
        !(Array.isArray(tier.bundleItems) && tier.bundleItems.length > 0),
    )
    .sort((a, b) => b.quantity - a.quantity);

  // The best tier whose quantity threshold the combined total meets.
  const tier = tiers.find((t) => totalQty >= t.quantity);
  if (!tier || !(tier.discountValue > 0)) return null;

  const message =
    (config.theme && config.theme.discountName) ||
    tier.badgeText ||
    `Buy ${tier.quantity}, save on ${config.title || "this item"}`;

  if (tier.discountType === "PERCENT") {
    return {
      message,
      targets,
      value: { percentage: { value: String(tier.discountValue) } },
    };
  }

  if (tier.discountType === "FIXED_PER_UNIT") {
    return {
      message,
      targets,
      value: {
        fixedAmount: {
          amount: String(tier.discountValue),
          appliesToEachItem: true,
        },
      },
    };
  }

  return null;
}

/**
 * Applies each configured offer's discount. The offer config is read from the
 * product's `quantity_breaks.config` metafield. Because mix-and-match bundles
 * spread a product's units across multiple variant lines, we group cart lines
 * by product, total their quantity, pick the tier from that total, and discount
 * all of the product's lines together.
 *
 * @param {RunInput} input
 * @returns {FunctionRunResult}
 */
export function run(input) {
  /**
   * @type {Map<string, {
   *   config: any,
   *   total: number,
   *   lines: { id: string, quantity: number, price: number }[],
   * }>}
   */
  const groups = new Map();
  /** @type {{ lineId: string, variantId: string, quantity: number }[]} */
  const allLines = [];

  for (const line of input.cart.lines) {
    const merchandise = line.merchandise;
    if (merchandise.__typename !== "ProductVariant") continue;
    allLines.push({
      lineId: line.id,
      variantId: merchandise.id,
      quantity: line.quantity,
    });

    const raw = merchandise.product?.metafield?.value;
    const productId = merchandise.product?.id;
    if (!raw || !productId) continue;

    let group = groups.get(productId);
    if (!group) {
      let config;
      try {
        config = JSON.parse(raw);
      } catch (_error) {
        continue;
      }
      group = { config, total: 0, lines: [] };
      groups.set(productId, group);
    }
    group.total += line.quantity;
    group.lines.push({
      id: line.id,
      quantity: line.quantity,
      price: parseFloat(line.cost?.amountPerQuantity?.amount ?? "0") || 0,
    });
  }

  const discounts = [];
  /** @type {Map<string, number>} variant id -> granted free quantity */
  const freeGiftQty = new Map();
  /**
   * Optional add-ons the shopper chose to add: variant id -> best discount %
   * and the quantity it applies to. Only discounted once it's actually in the
   * cart and its tier's threshold is met.
   * @type {Map<string, { percent: number, qty: number }>}
   */
  const addOnDiscounts = new Map();
  for (const [productId, { config, total, lines }] of groups) {
    if (!lines.length) continue;

    // Products that only appear as an *ingredient* of another product's
    // "complete the bundle" break (every target product gets the same synced
    // config) don't have independent tiers/gifts of their own — the anchor
    // group below handles them as part of the combined bundle discount.
    const isBundleFollower = (config.tiers || []).some(
      (t) =>
        Array.isArray(t.bundleItems) &&
        t.bundleItems.some((item) => item && item.productId === productId),
    );
    if (isBundleFollower) continue;

    const targets = lines.map((l) => ({ cartLine: { id: l.id } }));
    const discount =
      config.type === "BXGY"
        ? bxgyDiscount(config, total, lines)
        : quantityBreakDiscount(config, total, targets);
    if (discount) discounts.push(discount);

    const bundleDisc = bundleDiscount(config, productId, groups);
    if (bundleDisc) discounts.push(bundleDisc);

    // Gifts granted "at/above" any tier whose quantity the total meets; keep the
    // highest granted quantity per variant. `perUnit` gifts scale with how many
    // of the product are in the cart (buy N, get N free — no cap). A "complete
    // the bundle" tier's gifts only unlock once a full bundle set is present.
    for (const tier of config.tiers || []) {
      if (typeof tier.quantity !== "number") continue;
      const isBundleTier =
        Array.isArray(tier.bundleItems) && tier.bundleItems.length > 0;
      const qualifies = isBundleTier
        ? bundleSetsCompleted(tier, total, groups) >= 1
        : total >= tier.quantity;
      if (!qualifies) continue;
      for (const gift of tier.gifts || []) {
        if (!gift || !gift.variantId) continue;
        const per = typeof gift.quantity === "number" ? gift.quantity : 1;
        const qty = gift.perUnit === true ? per * total : per;
        if (gift.optional === true) {
          // Optional add-on: never free by default — only the configured
          // discount, and only on units the shopper actually added.
          const percent = Math.min(
            100,
            typeof gift.discountPercent === "number" ? gift.discountPercent : 0,
          );
          if (percent > 0) {
            const prev = addOnDiscounts.get(gift.variantId);
            if (!prev || percent > prev.percent || qty > prev.qty) {
              addOnDiscounts.set(gift.variantId, {
                percent: Math.max(percent, prev ? prev.percent : 0),
                qty: Math.max(qty, prev ? prev.qty : 0),
              });
            }
          }
          continue;
        }
        freeGiftQty.set(
          gift.variantId,
          Math.max(freeGiftQty.get(gift.variantId) || 0, qty),
        );
      }
    }
  }

  // Make the granted quantity of each gift free.
  if (freeGiftQty.size > 0) {
    for (const { lineId, variantId } of allLines) {
      const qty = freeGiftQty.get(variantId);
      if (qty) {
        discounts.push({
          message: "Free gift",
          targets: [{ cartLine: { id: lineId, quantity: qty } }],
          value: { percentage: { value: "100" } },
        });
      }
    }
  }

  // Discount the optional add-ons that are in the cart.
  if (addOnDiscounts.size > 0) {
    for (const { lineId, variantId, quantity } of allLines) {
      const addOn = addOnDiscounts.get(variantId);
      if (addOn) {
        discounts.push({
          message: "Add-on discount",
          // Never target more units than the line actually holds.
          targets: [
            { cartLine: { id: lineId, quantity: Math.min(addOn.qty, quantity) } },
          ],
          value: { percentage: { value: String(addOn.percent) } },
        });
      }
    }
  }

  if (discounts.length === 0) return EMPTY_DISCOUNT;

  return {
    discountApplicationStrategy: DiscountApplicationStrategy.All,
    discounts,
  };
}
