// Pure quantity-break domain logic — no Prisma / server imports, so it is safe
// to import from route loaders/actions, client components, and to mirror the
// same math used by the theme extension and discount function.

export const OFFER_STATUSES = ["DRAFT", "ACTIVE", "ARCHIVED"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const DISCOUNT_TYPES = ["NONE", "PERCENT", "FIXED_PER_UNIT"] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];

// The discount templates the merchant can choose from in the gallery. Each
// offer is one of these. Only the `available` ones can be created today; the
// rest are shown in the gallery for parity and built in later phases.
export const OFFER_TYPES = [
  "QUANTITY_BREAKS",
  "BXGY",
  "PACKS",
  "BUNDLE",
  "SUBSCRIPTION",
  "PROGRESSIVE_GIFTS",
] as const;
export type OfferType = (typeof OFFER_TYPES)[number];

export const OFFER_TYPE_META: {
  id: OfferType;
  title: string;
  caption: string;
  available: boolean;
}[] = [
  {
    id: "QUANTITY_BREAKS",
    title: "Quantity breaks",
    caption: "Quantity breaks for the same product",
    available: true,
  },
  {
    id: "BXGY",
    title: "Buy X, get Y",
    caption: "Buy X, get Y (BXGY) deal",
    available: true,
  },
  {
    id: "PACKS",
    title: "Multi-product packs",
    caption: "Quantity breaks for different products",
    available: false,
  },
  {
    id: "BUNDLE",
    title: "Complete the bundle",
    caption: "Complete the bundle",
    available: true,
  },
  {
    id: "SUBSCRIPTION",
    title: "Subscription",
    caption: "Subscription",
    available: false,
  },
  {
    id: "PROGRESSIVE_GIFTS",
    title: "Progressive gifts",
    caption: "Progressive gifts",
    available: false,
  },
];

// Coerce an untrusted value (DB column / query param) to a valid OfferType,
// defaulting to QUANTITY_BREAKS.
export function normalizeOfferType(value?: string | null): OfferType {
  return (OFFER_TYPES as readonly string[]).includes(value ?? "")
    ? (value as OfferType)
    : "QUANTITY_BREAKS";
}

// Whether an offer type can be created/edited today (vs. shown as "coming soon").
export function isOfferTypeAvailable(type: OfferType): boolean {
  const meta = OFFER_TYPE_META.find((m) => m.id === type);
  return meta ? meta.available : false;
}

// Per-aspect colors for the storefront widget. Each key maps to one visual
// element; the same values drive the admin preview, the theme extension CSS
// variables, and are mirrored into the product metafield.
export type ThemeColors = {
  headerColor: string;
  borderColor: string;
  accentColor: string;
  selectedBgColor: string;
  badgeBgColor: string;
  badgeTextColor: string;
  labelColor: string;
  subtitleColor: string;
  priceColor: string;
  compareAtColor: string;
  giftBgColor: string; // background of the free-gift section
  giftLabelColor: string; // "+ FREE ..." text
  giftPriceColor: string; // struck-through gift price
};

// Which products an offer targets. Only SPECIFIC is enforced today (one product
// per offer); the others are configurable but applied in a later phase.
export const VISIBILITY_SCOPES = [
  "ALL",
  "ALL_EXCEPT",
  "SPECIFIC",
  "COLLECTIONS",
] as const;
export type VisibilityScope = (typeof VISIBILITY_SCOPES)[number];

// How the countdown timer determines its end point.
export const COUNTDOWN_MODES = ["FIXED", "MIDNIGHT", "DATE"] as const;
export type CountdownMode = (typeof COUNTDOWN_MODES)[number];

export const COUNTDOWN_ALIGNMENTS = ["left", "center", "right"] as const;
export type CountdownAlignment = (typeof COUNTDOWN_ALIGNMENTS)[number];

// How the per-item variant pickers render in the bars.
//   dropdown – native <select> (default)
//   color    – color circle swatches (swatch background = the option value)
//   button   – pill/button swatches showing the value text
export const VARIANT_PICKER_TYPES = ["dropdown", "color", "button"] as const;
export type VariantPickerType = (typeof VARIANT_PICKER_TYPES)[number];

// The full offer config blob (stored as JSON on the offer + mirrored to the
// product metafield). Despite the name it now carries colors, typography,
// behavior, and the settings-panel options.
export type WidgetTheme = ThemeColors & {
  fontFamily: string; // CSS font-family stack, or "inherit" for the theme font
  fontSize: number; // base font size in px; child sizes scale from this
  tierRadius: number; // corner radius (px) of each quantity tier
  defaultTierQuantity: number | null; // tier (by quantity) selected on load; null = auto

  // --- Settings panel: name shown to customers in cart/checkout ---
  discountName: string; // discount label shown in cart/checkout (function message)

  // --- Pricing ---
  showPricePerItem: boolean; // show a per-unit price line under each tier
  showCompareAt: boolean; // show the struck-through compare-at price
  hidePriceDecimals: boolean; // [staged] render prices without decimals
  priceRounding: boolean; // [staged] charm-round displayed prices
  updateThemePrice: boolean; // [staged] sync the theme's product price to the tier

  // --- Variants ---
  hideThemeVariantPicker: boolean; // hide the theme's native variant selector
  hideUnavailableVariants: boolean; // hide sold-out variant swatch options
  letChooseVariantPerItem: boolean; // per-item variant choice in bundles
  hideOtherProductsOnVariant: boolean; // [staged] hide other products once a variant is picked
  variantPickerType: VariantPickerType; // how the per-item pickers render (dropdown/color/button)
  swatchSize: number; // swatch size in px (used by color/button picker types)
  swatchColors: Record<string, string>; // option value -> hex color for color swatches

  // --- Visibility (staged) ---
  visibilityScope: VisibilityScope;
  excludeB2B: boolean; // [staged] exclude B2B customers
  widgetOnly: boolean; // [staged] only discount when added via the widget

  // --- Active dates (staged) ---
  startDate: string; // ISO date or "" (no start)
  endDate: string; // ISO date or "" (no end)

  // --- Inventory ---
  lowStockAlert: boolean; // [staged] show a low-stock alert in the widget

  // --- Countdown timer ---
  countdownEnabled: boolean;
  countdownMode: CountdownMode; // FIXED minutes / MIDNIGHT / custom DATE
  countdownMinutes: number; // for FIXED: evergreen duration in minutes
  countdownEndDate: string; // for DATE: ISO datetime, else ""
  countdownTitle: string; // text with a {{timer}} placeholder
  countdownBgColor: string;
  countdownTextColor: string;
  countdownAlign: CountdownAlignment;
  countdownBold: boolean;
  countdownItalic: boolean;
  countdownFontSize: number; // px
  countdownRadius: number; // corner radius (px) of the countdown bar
  countdownPadding: number; // vertical padding (px) of the countdown bar
};

// Curated font choices offered in the editor. The value is the literal CSS
// font-family used both in the preview and the storefront.
export const FONT_OPTIONS: { label: string; value: string }[] = [
  { label: "Theme default", value: "inherit" },
  {
    label: "System sans-serif",
    value:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  },
  { label: "Helvetica / Arial", value: "Helvetica, Arial, sans-serif" },
  { label: "Georgia (serif)", value: "Georgia, 'Times New Roman', serif" },
  { label: "Times New Roman", value: "'Times New Roman', Times, serif" },
  { label: "Courier (monospace)", value: "'Courier New', Courier, monospace" },
];

export const DEFAULT_THEME: WidgetTheme = {
  headerColor: "#1a1a1a",
  borderColor: "#e3e3e3",
  accentColor: "#3b5bfd",
  selectedBgColor: "#f5f7ff",
  badgeBgColor: "#e11d48",
  badgeTextColor: "#ffffff",
  labelColor: "#1a1a1a",
  subtitleColor: "#6b7280",
  priceColor: "#1a1a1a",
  compareAtColor: "#9ca3af",
  giftBgColor: "#f0fdf4",
  giftLabelColor: "#15803d",
  giftPriceColor: "#9ca3af",
  fontFamily: "inherit",
  fontSize: 14,
  tierRadius: 12,
  defaultTierQuantity: null,
  discountName: "",
  showPricePerItem: false,
  showCompareAt: true,
  hidePriceDecimals: false,
  priceRounding: false,
  updateThemePrice: false,
  hideThemeVariantPicker: false,
  hideUnavailableVariants: false,
  letChooseVariantPerItem: false,
  hideOtherProductsOnVariant: false,
  variantPickerType: "dropdown",
  swatchSize: 36,
  swatchColors: {},
  visibilityScope: "SPECIFIC",
  excludeB2B: false,
  widgetOnly: false,
  startDate: "",
  endDate: "",
  lowStockAlert: false,
  countdownEnabled: false,
  countdownMode: "FIXED",
  countdownMinutes: 15,
  countdownEndDate: "",
  countdownTitle: "Hurry! Offer expires in {{timer}} ⏰",
  countdownBgColor: "#fde8ef",
  countdownTextColor: "#1a1a1a",
  countdownAlign: "center",
  countdownBold: false,
  countdownItalic: false,
  countdownFontSize: 13,
  countdownRadius: 8,
  countdownPadding: 8,
};

// Human-readable labels for each color, used to render the editor controls.
export const THEME_FIELDS: { key: keyof ThemeColors; label: string }[] = [
  { key: "headerColor", label: "Header text" },
  { key: "borderColor", label: "Tier border" },
  { key: "accentColor", label: "Selected accent" },
  { key: "selectedBgColor", label: "Selected background" },
  { key: "badgeBgColor", label: "Badge background" },
  { key: "badgeTextColor", label: "Badge text" },
  { key: "labelColor", label: "Tier label" },
  { key: "subtitleColor", label: "Subtitle / savings" },
  { key: "priceColor", label: "Price" },
  { key: "compareAtColor", label: "Compare-at price" },
  { key: "giftBgColor", label: "Gift background" },
  { key: "giftLabelColor", label: "Gift text" },
  { key: "giftPriceColor", label: "Gift price" },
];

// Merge a possibly-partial/untrusted theme over the defaults so every key is
// always present. Accepts the JSON-parsed value from the DB or metafield.
export function normalizeTheme(partial?: Partial<WidgetTheme> | null): WidgetTheme {
  const result = { ...DEFAULT_THEME };
  if (partial) {
    for (const { key } of THEME_FIELDS) {
      const value = partial[key];
      if (typeof value === "string" && value.trim()) result[key] = value;
    }
    if (typeof partial.fontFamily === "string" && partial.fontFamily.trim())
      result.fontFamily = partial.fontFamily;
    if (typeof partial.fontSize === "number" && partial.fontSize > 0)
      result.fontSize = partial.fontSize;
    if (typeof partial.tierRadius === "number" && partial.tierRadius >= 0)
      result.tierRadius = partial.tierRadius;
    if (typeof partial.defaultTierQuantity === "number")
      result.defaultTierQuantity = partial.defaultTierQuantity;
    else if (partial.defaultTierQuantity === null)
      result.defaultTierQuantity = null;

    // Settings-panel booleans — copied through when present.
    const boolKeys: (keyof WidgetTheme)[] = [
      "showPricePerItem",
      "showCompareAt",
      "hidePriceDecimals",
      "priceRounding",
      "updateThemePrice",
      "hideThemeVariantPicker",
      "hideUnavailableVariants",
      "letChooseVariantPerItem",
      "hideOtherProductsOnVariant",
      "excludeB2B",
      "widgetOnly",
      "lowStockAlert",
      "countdownEnabled",
      "countdownBold",
      "countdownItalic",
    ];
    for (const key of boolKeys) {
      if (typeof partial[key] === "boolean") {
        (result[key] as boolean) = partial[key] as boolean;
      }
    }

    if (
      typeof partial.variantPickerType === "string" &&
      (VARIANT_PICKER_TYPES as readonly string[]).includes(
        partial.variantPickerType,
      )
    )
      result.variantPickerType = partial.variantPickerType as VariantPickerType;
    if (typeof partial.swatchSize === "number" && partial.swatchSize > 0)
      result.swatchSize = partial.swatchSize;
    if (partial.swatchColors && typeof partial.swatchColors === "object") {
      const colors: Record<string, string> = {};
      for (const [k, v] of Object.entries(partial.swatchColors)) {
        if (typeof v === "string" && v.trim()) colors[k] = v;
      }
      result.swatchColors = colors;
    }

    if (typeof partial.discountName === "string")
      result.discountName = partial.discountName;
    if (typeof partial.startDate === "string")
      result.startDate = partial.startDate;
    if (typeof partial.endDate === "string") result.endDate = partial.endDate;

    if (
      typeof partial.visibilityScope === "string" &&
      (VISIBILITY_SCOPES as readonly string[]).includes(partial.visibilityScope)
    )
      result.visibilityScope = partial.visibilityScope as VisibilityScope;

    // Countdown timer
    if (
      typeof partial.countdownMode === "string" &&
      (COUNTDOWN_MODES as readonly string[]).includes(partial.countdownMode)
    )
      result.countdownMode = partial.countdownMode as CountdownMode;
    if (
      typeof partial.countdownAlign === "string" &&
      (COUNTDOWN_ALIGNMENTS as readonly string[]).includes(
        partial.countdownAlign,
      )
    )
      result.countdownAlign = partial.countdownAlign as CountdownAlignment;
    if (typeof partial.countdownMinutes === "number" && partial.countdownMinutes > 0)
      result.countdownMinutes = partial.countdownMinutes;
    if (typeof partial.countdownFontSize === "number" && partial.countdownFontSize > 0)
      result.countdownFontSize = partial.countdownFontSize;
    if (typeof partial.countdownRadius === "number" && partial.countdownRadius >= 0)
      result.countdownRadius = partial.countdownRadius;
    if (typeof partial.countdownPadding === "number" && partial.countdownPadding >= 0)
      result.countdownPadding = partial.countdownPadding;
    if (typeof partial.countdownEndDate === "string")
      result.countdownEndDate = partial.countdownEndDate;
    if (typeof partial.countdownTitle === "string")
      result.countdownTitle = partial.countdownTitle;
    if (typeof partial.countdownBgColor === "string" && partial.countdownBgColor.trim())
      result.countdownBgColor = partial.countdownBgColor;
    if (typeof partial.countdownTextColor === "string" && partial.countdownTextColor.trim())
      result.countdownTextColor = partial.countdownTextColor;
  }
  return result;
}

// Parse a theme JSON string (DB column) into a full WidgetTheme, falling back
// to defaults when null/invalid.
export function parseTheme(raw?: string | null): WidgetTheme {
  if (!raw) return { ...DEFAULT_THEME };
  try {
    return normalizeTheme(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_THEME };
  }
}

// A free gift attached to a tier: a specific variant given at $0 when the tier
// (by quantity) is met. Unlimited gifts can be stacked on a tier.
export type Gift = {
  productId: string; // Shopify product GID (for the admin picker)
  variantId: string; // Shopify variant GID — what's added to the cart / discounted
  handle: string; // product handle — used in Liquid to look up live price via all_products
  title: string; // product/variant title shown as "+ FREE <title>"
  price: number; // regular price, shown struck-through (fallback when handle lookup fails)
  quantity: number; // how many of this gift are given free (>= 1)
  // When true, `quantity` is per purchased unit — buy N of the product and get
  // N × quantity free (scales without a cap). When false it's a flat count.
  perUnit: boolean;
  imageUrl: string | null;
};

// One product inside a "Complete the bundle" break. The storefront reads the
// live product (price, variants, image) via `all_products[handle]`, so only the
// identity + quantity need to travel in the metafield; the snapshot fields are
// for the admin list/preview.
export type BundleItem = {
  productId: string; // Shopify product GID (admin picker)
  handle: string; // product handle — how the storefront looks it up live
  title: string;
  price: number; // snapshot, for the admin list
  imageUrl: string | null;
  quantity: number; // how many of this product the bundle includes (>= 1)
};

export type TierInput = {
  quantity: number; // BXGY: the "buy" (X) quantity
  getQuantity?: number | null; // BXGY: the "get" (Y) quantity; null for quantity breaks
  discountType: DiscountType; // BXGY: discount applied to the Y units
  discountValue: number;
  label?: string | null;
  subtitle?: string | null;
  badgeText?: string | null;
  highlight: boolean;
  gifts?: Gift[]; // free gifts granted at/above this tier's quantity
  // "Complete the bundle" break: when set, this break is a multi-product bundle
  // discounted by `discountValue`% instead of N units of the offer's product.
  bundleItems?: BundleItem[];
};

export type OfferInput = {
  title: string;
  type: OfferType;
  status: OfferStatus;
  productId?: string | null;
  productTitle?: string | null;
  imageUrl?: string | null;
  basePrice: number;
  headerText?: string | null;
  theme: WidgetTheme;
  tiers: TierInput[];
};

export type TierPricing = {
  quantity: number;
  unitPrice: number; // discounted price per unit
  total: number; // discounted total for the tier
  compareAt: number; // undiscounted total (basePrice * quantity)
  savings: number; // compareAt - total
  savingsPercent: number; // 0-100
};

// Resolve the discounted unit price for a single tier given the base price.
export function tierUnitPrice(basePrice: number, tier: TierInput): number {
  let unit = basePrice;
  if (tier.discountType === "PERCENT") {
    unit = basePrice * (1 - clamp(tier.discountValue, 0, 100) / 100);
  } else if (tier.discountType === "FIXED_PER_UNIT") {
    unit = basePrice - tier.discountValue;
  }
  return round(Math.max(0, unit));
}

// Compute the full pricing breakdown for a tier.
export function computeTierPricing(
  basePrice: number,
  tier: TierInput,
): TierPricing {
  const qty = Math.max(1, Math.floor(tier.quantity));
  const unitPrice = tierUnitPrice(basePrice, tier);
  const total = round(unitPrice * qty);
  const compareAt = round(basePrice * qty);
  const savings = round(compareAt - total);
  const savingsPercent = compareAt > 0 ? round((savings / compareAt) * 100) : 0;
  return { quantity: qty, unitPrice, total, compareAt, savings, savingsPercent };
}

export function computeOfferPricing(
  input: Pick<OfferInput, "basePrice" | "tiers">,
): TierPricing[] {
  return input.tiers.map((tier) => computeTierPricing(input.basePrice, tier));
}

// Pricing for a "complete the bundle" break: the anchor product (this offer's
// own product, `tier.quantity` units of it) plus every bundle item at its own
// price, discounted as a whole by `discountValue`% (or a flat $ off per unit).
export function computeBundlePricing(
  basePrice: number,
  tier: TierInput,
): TierPricing {
  const anchorQty = Math.max(1, Math.floor(tier.quantity));
  const items = tier.bundleItems ?? [];
  const itemsTotal = items.reduce(
    (sum, item) => sum + item.price * Math.max(1, Math.floor(item.quantity)),
    0,
  );
  const compareAt = round(basePrice * anchorQty + itemsTotal);
  let total = compareAt;
  if (tier.discountType === "PERCENT") {
    total = round(compareAt * (1 - clamp(tier.discountValue, 0, 100) / 100));
  } else if (tier.discountType === "FIXED_PER_UNIT") {
    const units = anchorQty + items.reduce(
      (sum, item) => sum + Math.max(1, Math.floor(item.quantity)),
      0,
    );
    total = round(Math.max(0, compareAt - tier.discountValue * units));
  }
  const savings = round(compareAt - total);
  const savingsPercent = compareAt > 0 ? round((savings / compareAt) * 100) : 0;
  return { quantity: anchorQty, unitPrice: total, total, compareAt, savings, savingsPercent };
}

// Bundle tiers price differently from ordinary quantity tiers (sum of distinct
// product prices, not basePrice × quantity) — pick the right calculator.
export function computeAnyTierPricing(
  basePrice: number,
  tier: TierInput,
): TierPricing {
  return tier.bundleItems && tier.bundleItems.length > 0
    ? computeBundlePricing(basePrice, tier)
    : computeTierPricing(basePrice, tier);
}

// Total units a tier puts in the cart: quantity breaks = the quantity; BXGY =
// buy (X) + get (Y). The discount function matches a cart line against this.
export function tierTotalUnits(tier: TierInput): number {
  const x = Math.max(1, Math.floor(tier.quantity));
  const y = Math.max(0, Math.floor(tier.getQuantity ?? 0));
  return x + y;
}

export type BxgyPricing = {
  buyQuantity: number; // X, paid at full price
  getQuantity: number; // Y, discounted
  totalUnits: number; // X + Y
  total: number; // what the shopper pays
  compareAt: number; // (X + Y) * basePrice
  savings: number; // compareAt - total
  savingsPercent: number; // 0-100
};

// Pricing for one BXGY tier: X units at full price + Y units discounted by the
// tier's discountType/discountValue (PERCENT 100 = free).
export function computeBxgyPricing(
  basePrice: number,
  tier: TierInput,
): BxgyPricing {
  const x = Math.max(1, Math.floor(tier.quantity));
  const y = Math.max(1, Math.floor(tier.getQuantity ?? 1));
  const yUnit = tierUnitPrice(basePrice, tier); // discount applies to Y units
  const total = round(basePrice * x + yUnit * y);
  const compareAt = round(basePrice * (x + y));
  const savings = round(compareAt - total);
  const savingsPercent = compareAt > 0 ? round((savings / compareAt) * 100) : 0;
  return {
    buyQuantity: x,
    getQuantity: y,
    totalUnits: x + y,
    total,
    compareAt,
    savings,
    savingsPercent,
  };
}

// Validate a BXGY offer. Each ordinary tier is a "buy X, get Y" rule; the
// discount function matches a cart line by its total units (X+Y), so those
// totals must be unique. A tier that's also a "complete the bundle" break
// (has bundleItems) is matched by its bundle contents instead, so it's exempt
// from both the totals-uniqueness and get-quantity requirements.
function validateBxgy(input: OfferInput): string[] {
  const errors: string[] = [];

  if (!input.title.trim()) errors.push("Offer title is required.");
  if (!input.productId) errors.push("Select a product for this offer.");
  if (input.basePrice <= 0)
    errors.push("The product needs a base price greater than 0.");
  if (input.tiers.length < 1) errors.push("Add at least one Buy X, get Y tier.");

  const seenTotals = new Set<number>();
  for (const tier of input.tiers) {
    const x = tier.quantity;
    const y = tier.getQuantity ?? 0;
    const isBundleTier = (tier.bundleItems ?? []).length > 0;
    if (x < 1) errors.push("Every tier needs a buy quantity of 1+.");
    if (y < 1 && !isBundleTier)
      errors.push("Every tier needs a get quantity of 1+.");

    if (!isBundleTier) {
      const total = x + y;
      if (seenTotals.has(total))
        errors.push(`Two tiers both total ${total} items — make them distinct.`);
      seenTotals.add(total);
    }

    if (tier.discountType === "PERCENT") {
      if (tier.discountValue < 0 || tier.discountValue > 100)
        errors.push("Percent off the free items must be between 0 and 100.");
    }
    if (tier.discountType === "FIXED_PER_UNIT" && tier.discountValue < 0)
      errors.push("Fixed discount cannot be negative.");
  }

  if (input.tiers.filter((t) => t.highlight).length > 1)
    errors.push("Only one tier can be marked as Most popular.");

  return errors;
}

// Validate a "Complete the bundle" offer. Breaks aren't quantity-unique here:
// several bundle breaks can legitimately all need just 1 of the anchor
// product, and a break started empty (before its products are added) would
// otherwise collide with any other break sitting at the same quantity.
function validateBundle(input: OfferInput): string[] {
  const errors: string[] = [];

  if (!input.title.trim()) errors.push("Offer title is required.");
  if (!input.productId) errors.push("Select a product for this offer.");
  if (input.basePrice <= 0)
    errors.push("The product needs a base price greater than 0.");
  if (input.tiers.length < 1) errors.push("Add at least one break.");
  if (!input.tiers.some((t) => (t.bundleItems ?? []).length > 0))
    errors.push("Add at least one product to a break to complete the bundle.");

  for (const tier of input.tiers) {
    if (tier.quantity < 1) errors.push("Every break needs a quantity of 1+.");

    if (tier.discountType === "PERCENT") {
      if (tier.discountValue < 0 || tier.discountValue > 100)
        errors.push("Percent discount must be between 0 and 100.");
    }
    if (tier.discountType === "FIXED_PER_UNIT" && tier.discountValue < 0)
      errors.push("Fixed discount cannot be negative.");
  }

  if (input.tiers.filter((t) => t.highlight).length > 1)
    errors.push("Only one tier can be marked as Most popular.");

  return errors;
}

// Validate an offer's configuration. Returns a list of human-readable errors.
export function validateOffer(input: OfferInput): string[] {
  if (input.type === "BXGY") return validateBxgy(input);
  if (input.type === "BUNDLE") return validateBundle(input);

  const errors: string[] = [];

  if (!input.title.trim()) errors.push("Offer title is required.");
  if (!input.productId) errors.push("Select a product for this offer.");
  if (input.basePrice <= 0)
    errors.push("The product needs a base price greater than 0.");
  if (input.tiers.length < 2)
    errors.push("Add at least 2 quantity tiers (e.g. 1, 2, 3).");

  const seen = new Set<number>();
  for (const tier of input.tiers) {
    if (tier.quantity < 1) errors.push("Every tier needs a quantity of 1+.");
    // A "complete the bundle" break is matched by its bundle contents, not by
    // quantity, so it's exempt from the quantity-uniqueness requirement.
    const isBundleTier = (tier.bundleItems ?? []).length > 0;
    if (!isBundleTier) {
      if (seen.has(tier.quantity))
        errors.push(`Duplicate tier for quantity ${tier.quantity}.`);
      seen.add(tier.quantity);
    }

    if (tier.discountType === "PERCENT") {
      if (tier.discountValue < 0 || tier.discountValue > 100)
        errors.push("Percent discount must be between 0 and 100.");
    }
    if (tier.discountType === "FIXED_PER_UNIT" && tier.discountValue < 0)
      errors.push("Fixed discount cannot be negative.");
  }

  const highlighted = input.tiers.filter((t) => t.highlight).length;
  if (highlighted > 1)
    errors.push("Only one tier can be marked as Most popular.");

  return errors;
}

// The compact JSON shape mirrored to the product metafield and consumed by the
// theme extension + discount function. Keep this stable across all three.
export type OfferMetafield = {
  title: string;
  type: OfferType;
  headerText: string | null;
  basePrice: number;
  theme: WidgetTheme;
  tiers: {
    quantity: number;
    getQuantity: number | null;
    discountType: DiscountType;
    discountValue: number;
    label: string | null;
    subtitle: string | null;
    badgeText: string | null;
    highlight: boolean;
    gifts: Gift[];
    bundleItems: BundleItem[];
  }[];
};

// Keep only well-formed bundle items (need a handle to look the product up
// live on the storefront).
export function sanitizeBundleItems(items: unknown): BundleItem[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((i) => i && typeof i === "object")
    .map((i: any) => ({
      productId: String(i.productId ?? ""),
      handle: String(i.handle ?? ""),
      title: String(i.title ?? ""),
      price: typeof i.price === "number" && i.price >= 0 ? i.price : 0,
      imageUrl: i.imageUrl ? String(i.imageUrl) : null,
      quantity:
        typeof i.quantity === "number" && i.quantity >= 1
          ? Math.floor(i.quantity)
          : 1,
    }))
    .filter((i) => i.handle);
}

// Keep only well-formed gifts (a valid variant id + numeric price).
export function sanitizeGifts(gifts: unknown): Gift[] {
  if (!Array.isArray(gifts)) return [];
  return gifts
    .filter((g) => g && typeof g === "object")
    .map((g: any) => ({
      productId: String(g.productId ?? ""),
      variantId: String(g.variantId ?? ""),
      handle: String(g.handle ?? ""),
      title: String(g.title ?? "Free gift"),
      price: typeof g.price === "number" && g.price >= 0 ? g.price : 0,
      quantity:
        typeof g.quantity === "number" && g.quantity >= 1
          ? Math.floor(g.quantity)
          : 1,
      perUnit: g.perUnit === true,
      imageUrl: g.imageUrl ? String(g.imageUrl) : null,
    }))
    .filter((g) => g.variantId);
}

export function toMetafield(input: OfferInput): OfferMetafield {
  return {
    title: input.title,
    type: normalizeOfferType(input.type),
    headerText: input.headerText ?? null,
    basePrice: input.basePrice,
    theme: normalizeTheme(input.theme),
    tiers: input.tiers
      .slice()
      .sort((a, b) => a.quantity - b.quantity)
      .map((tier) => ({
        quantity: tier.quantity,
        getQuantity: tier.getQuantity ?? null,
        discountType: tier.discountType,
        discountValue: tier.discountValue,
        label: tier.label ?? null,
        subtitle: tier.subtitle ?? null,
        badgeText: tier.badgeText ?? null,
        highlight: tier.highlight,
        gifts: sanitizeGifts(tier.gifts),
        bundleItems: sanitizeBundleItems(tier.bundleItems),
      })),
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
