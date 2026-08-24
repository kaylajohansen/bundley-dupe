import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
} from "@remix-run/node";
import { redirect } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigate,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  FormLayout,
  TextField,
  Select,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Banner,
  Box,
  Checkbox,
  ChoiceList,
  Collapsible,
  Divider,
  Thumbnail,
  RangeSlider,
  Modal,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import {
  createOffer,
  updateOffer,
  deleteOffer,
  getOffer,
  syncOfferToMetafield,
  ensureDiscountActivated,
} from "../models/offer.server";
import {
  validateOffer,
  computeTierPricing,
  computeBxgyPricing,
  computeAnyTierPricing,
  tierUnitPrice,
  parseTheme,
  normalizeTheme,
  THEME_FIELDS,
  FONT_OPTIONS,
  OFFER_TYPE_META,
  normalizeOfferType,
  isOfferTypeAvailable,
  sanitizeGifts,
  sanitizeBundleItems,
  type Gift,
  type BundleItem,
  type VariantPickerType,
  type OfferInput,
  type OfferStatus,
  type OfferType,
  type VisibilityScope,
  type CountdownMode,
  type CountdownAlignment,
  type TierInput,
  type DiscountType,
  type ThemeColors,
  type WidgetTheme,
} from "../lib/offer-pricing";

type ProductOption = { name: string; values: string[] };

type AdminGraphql = (
  query: string,
  options?: { variables?: Record<string, unknown> },
) => Promise<Response>;

// Fetch a product's option names + values so the editor (and the "Add swatches"
// modal) can show the real options instead of placeholders. Returns [] on any
// problem so the editor still renders.
async function fetchProductOptions(
  graphql: AdminGraphql,
  productId: string | null | undefined,
): Promise<ProductOption[]> {
  if (!productId) return [];
  try {
    const resp = await graphql(
      `#graphql
        query QbProductOptions($id: ID!) {
          product(id: $id) {
            options(first: 10) {
              name
              optionValues {
                name
              }
            }
          }
        }`,
      { variables: { id: productId } },
    );
    const json = await resp.json();
    const options = json?.data?.product?.options ?? [];
    return options.map((o: any) => ({
      name: o.name as string,
      values: (o.optionValues ?? []).map((v: any) => v.name as string),
    }));
  } catch {
    return [];
  }
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  if (params.id === "new") {
    const url = new URL(request.url);
    return {
      offer: null,
      shop: session.shop,
      createType: normalizeOfferType(url.searchParams.get("type")),
      createAccent: url.searchParams.get("accent"),
      productOptions: [] as ProductOption[],
    };
  }

  const offer = await getOffer(session.shop, params.id!);
  if (!offer) throw new Response("Offer not found", { status: 404 });
  const productOptions = await fetchProductOptions(
    admin.graphql,
    offer.productId,
  );
  return {
    offer,
    shop: session.shop,
    createType: null,
    createAccent: null,
    productOptions,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "delete") {
    const existing = await getOffer(session.shop, params.id!);
    if (existing) {
      // Clear the storefront metafield before removing the offer.
      await syncOfferToMetafield(admin.graphql, {
        ...existing,
        status: "ARCHIVED",
      });
      await deleteOffer(session.shop, params.id!);
    }
    return redirect("/app/offers");
  }

  const tiers = JSON.parse(
    String(formData.get("tiers") || "[]"),
  ) as TierInput[];

  const input: OfferInput = {
    title: String(formData.get("title") || "").trim(),
    type: normalizeOfferType(String(formData.get("type") || "")),
    status: String(formData.get("status") || "DRAFT") as OfferStatus,
    productId: String(formData.get("productId") || "") || null,
    productTitle: String(formData.get("productTitle") || "") || null,
    imageUrl: String(formData.get("imageUrl") || "") || null,
    basePrice: Number(formData.get("basePrice") || 0),
    headerText: String(formData.get("headerText") || "") || null,
    theme: parseTheme(String(formData.get("theme") || "")),
    tiers,
  };

  const errors = validateOffer(input);
  if (errors.length > 0) return { errors };

  const saved =
    params.id === "new"
      ? await createOffer(session.shop, input)
      : await updateOffer(session.shop, params.id!, input);

  if (!saved) throw new Response("Offer not found", { status: 404 });

  await syncOfferToMetafield(admin.graphql, saved);

  // An active offer only discounts at checkout once the automatic app
  // discount backed by our function exists. Create it on first activation;
  // if the function isn't registered yet, keep the merchant on the page and
  // tell them why instead of silently redirecting.
  if (saved.status === "ACTIVE") {
    const result = await ensureDiscountActivated(admin.graphql);
    if (!result.activated) {
      return { savedId: saved.id, warning: result.reason };
    }
  }

  return redirect("/app/offers");
};

const DISCOUNT_OPTIONS = [
  { label: "No discount", value: "NONE" },
  { label: "% off", value: "PERCENT" },
  { label: "$ off each", value: "FIXED_PER_UNIT" },
];

function defaultTiers(): TierInput[] {
  return [
    {
      quantity: 1,
      discountType: "NONE",
      discountValue: 0,
      label: "Single",
      subtitle: "Standard price",
      badgeText: null,
      highlight: false,
    },
    {
      quantity: 2,
      discountType: "PERCENT",
      discountValue: 15,
      label: "Duo",
      subtitle: null,
      badgeText: "MOST POPULAR",
      highlight: true,
    },
    {
      quantity: 3,
      discountType: "PERCENT",
      discountValue: 25,
      label: "Trio",
      subtitle: null,
      badgeText: null,
      highlight: false,
    },
  ];
}

// Buy X, get Y starter tiers. The "get" units default to free (PERCENT 100).
function defaultBxgyTiers(): TierInput[] {
  return [
    {
      quantity: 1,
      getQuantity: 1,
      discountType: "PERCENT",
      discountValue: 100,
      label: "Buy 1, get 1 free",
      subtitle: null,
      badgeText: null,
      highlight: false,
    },
    {
      quantity: 2,
      getQuantity: 3,
      discountType: "PERCENT",
      discountValue: 100,
      label: "Buy 2, get 3 free",
      subtitle: null,
      badgeText: "MOST POPULAR",
      highlight: true,
    },
    {
      quantity: 3,
      getQuantity: 6,
      discountType: "PERCENT",
      discountValue: 100,
      label: "Buy 3, get 6 free",
      subtitle: null,
      badgeText: null,
      highlight: false,
    },
  ];
}

// "Complete the bundle" starter: one break that's already a bundle (empty
// bundleItems, ready for the merchant to add products) discounted as a whole.
function defaultBundleTiers(): TierInput[] {
  return [
    {
      quantity: 1,
      discountType: "PERCENT",
      discountValue: 20,
      label: "Complete the bundle",
      subtitle: null,
      badgeText: null,
      highlight: true,
      bundleItems: [],
    },
  ];
}

export default function OfferEditor() {
  const {
    offer,
    shop,
    createType,
    createAccent,
    productOptions: loadedOptions,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const submit = useSubmit();
  const shopify = useAppBridge();

  const isNew = offer === null;
  const isSaving = navigation.state === "submitting";

  const offerType: OfferType = offer
    ? normalizeOfferType(offer.type)
    : (createType ?? "QUANTITY_BREAKS");
  const typeMeta = OFFER_TYPE_META.find((m) => m.id === offerType);

  const [title, setTitle] = useState(offer?.title ?? "Quantity discount");
  const [status, setStatus] = useState<OfferStatus>(
    (offer?.status as OfferStatus) ?? "DRAFT",
  );
  const [headerText, setHeaderText] = useState(
    offer?.headerText ?? "BUY MORE = SAVE MORE",
  );
  const [productId, setProductId] = useState(offer?.productId ?? "");
  const [productTitle, setProductTitle] = useState(offer?.productTitle ?? "");
  const [imageUrl, setImageUrl] = useState(offer?.imageUrl ?? "");
  const [basePrice, setBasePrice] = useState(String(offer?.basePrice ?? 0));
  const isBxgy = offerType === "BXGY";
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [stylesOpen, setStylesOpen] = useState(true);
  const [countdownOpen, setCountdownOpen] = useState(true);
  // Real product options (name + values), used by the "Add swatches" modal and
  // the live preview. Seeded from the loader; refreshed when a product is picked.
  const [productOptions, setProductOptions] = useState<ProductOption[]>(
    loadedOptions ?? [],
  );
  // "Add swatches" modal: drafts are committed to the theme only on Apply.
  const [swatchModalOpen, setSwatchModalOpen] = useState(false);
  const [draftPickerType, setDraftPickerType] =
    useState<VariantPickerType>("dropdown");
  const [draftSwatchSize, setDraftSwatchSize] = useState(36);
  const [draftOption, setDraftOption] = useState("");
  const [draftSwatchColors, setDraftSwatchColors] = useState<
    Record<string, string>
  >({});
  // Indices of collapsed tier bars (a tier is expanded unless listed here).
  const [collapsedTiers, setCollapsedTiers] = useState<number[]>([]);
  const isTierOpen = (index: number) => !collapsedTiers.includes(index);
  const toggleTier = (index: number) =>
    setCollapsedTiers((current) =>
      current.includes(index)
        ? current.filter((i) => i !== index)
        : [...current, index],
    );
  const [tiers, setTiers] = useState<TierInput[]>(
    offer?.tiers.map((tier) => ({
      quantity: tier.quantity,
      getQuantity: tier.getQuantity,
      discountType: tier.discountType as DiscountType,
      discountValue: tier.discountValue,
      label: tier.label,
      subtitle: tier.subtitle,
      badgeText: tier.badgeText,
      highlight: tier.highlight,
      gifts: sanitizeGifts(tier.gifts ? JSON.parse(tier.gifts) : []),
      bundleItems: sanitizeBundleItems(
        tier.bundleItems ? JSON.parse(tier.bundleItems) : [],
      ),
    })) ??
      (isBxgy
        ? defaultBxgyTiers()
        : offerType === "BUNDLE"
          ? defaultBundleTiers()
          : defaultTiers()),
  );
  const [theme, setTheme] = useState<WidgetTheme>(() => {
    const base = parseTheme(offer?.theme ?? null);
    // Seed the accent color from the gallery's color-theme picker on create.
    if (!offer && createAccent && /^#[0-9a-fA-F]{6}$/.test(createAccent)) {
      return { ...base, accentColor: createAccent };
    }
    return base;
  });

  const setColor = (key: keyof ThemeColors, value: string) =>
    setTheme((current) => ({ ...current, [key]: value }));

  const setSetting = <K extends keyof WidgetTheme,>(
    key: K,
    value: WidgetTheme[K],
  ) => setTheme((current) => ({ ...current, [key]: value }));

  const openSwatchModal = () => {
    setDraftPickerType(theme.variantPickerType);
    setDraftSwatchSize(theme.swatchSize);
    setDraftOption(productOptions[0]?.name ?? "");
    setDraftSwatchColors({ ...theme.swatchColors });
    setSwatchModalOpen(true);
  };
  const applySwatchModal = () => {
    setTheme((current) => ({
      ...current,
      variantPickerType: draftPickerType,
      swatchSize: draftSwatchSize,
      swatchColors: draftSwatchColors,
    }));
    setSwatchModalOpen(false);
  };

  const price = Number(basePrice) || 0;

  // Which option's values the swatch modal previews (real options when known).
  const swatchOption =
    productOptions.find((o) => o.name === draftOption) ?? productOptions[0];
  const swatchOptionName = swatchOption?.name ?? "Color";
  const swatchValues =
    swatchOption && swatchOption.values.length > 0
      ? swatchOption.values
      : SAMPLE_VALUES;

  const pickProduct = useCallback(async () => {
    const selection = await shopify.resourcePicker({
      type: "product",
      multiple: false,
      ...(productId ? { selectionIds: [{ id: productId }] } : {}),
    });
    if (!selection || selection.length === 0) return;
    const product: any = selection[0];
    const variant = product.variants?.[0];
    setProductId(product.id);
    setProductTitle(product.title);
    setImageUrl(product.images?.[0]?.originalSrc ?? "");
    if (variant?.price != null) setBasePrice(String(variant.price));
    // Capture the picked product's options so the swatch modal / preview show
    // the real options. The resource picker exposes option values directly or
    // under `optionValues`; handle both shapes defensively.
    setProductOptions(
      (product.options ?? []).map((o: any) => ({
        name: o.name as string,
        values: (o.values ?? o.optionValues ?? []).map((v: any) =>
          typeof v === "string" ? v : (v?.name ?? ""),
        ),
      })),
    );
  }, [shopify, productId]);

  const updateTier = (index: number, patch: Partial<TierInput>) => {
    setTiers((current) =>
      current.map((tier, i) => {
        if (i !== index) {
          // Only one tier can be highlighted.
          return patch.highlight ? { ...tier, highlight: false } : tier;
        }
        return { ...tier, ...patch };
      }),
    );
  };

  // Pick a product as a free gift for a tier (uses its first variant).
  const addGift = useCallback(
    async (tierIndex: number) => {
      const selection = await shopify.resourcePicker({
        type: "product",
        multiple: false,
      });
      if (!selection || selection.length === 0) return;
      const product: any = selection[0];
      const variant = product.variants?.[0];
      // The picker returns price as a number, a string, or a { amount } object.
      const rawPrice = variant?.price;
      let price = 0;
      if (typeof rawPrice === "number") price = rawPrice;
      else if (typeof rawPrice === "string") price = Number(rawPrice) || 0;
      else if (rawPrice && typeof rawPrice === "object")
        price = Number(rawPrice.amount ?? rawPrice.price ?? 0) || 0;
      const gift: Gift = {
        productId: String(product.id),
        variantId: String(variant?.id ?? product.id),
        handle: String(product.handle ?? ""),
        title: String(product.title ?? "Free gift"),
        price,
        quantity: 1,
        perUnit: false,
        imageUrl: product.images?.[0]?.originalSrc ?? null,
      };
      setTiers((current) =>
        current.map((t, i) =>
          i === tierIndex ? { ...t, gifts: [...(t.gifts ?? []), gift] } : t,
        ),
      );
    },
    [shopify],
  );

  const updateGift = (
    tierIndex: number,
    giftIndex: number,
    patch: Partial<Gift>,
  ) =>
    setTiers((current) =>
      current.map((t, i) =>
        i === tierIndex
          ? {
              ...t,
              gifts: (t.gifts ?? []).map((g, gi) =>
                gi === giftIndex ? { ...g, ...patch } : g,
              ),
            }
          : t,
      ),
    );

  // Pick a product to include in this break's "complete the bundle" set.
  const addBundleItem = useCallback(
    async (tierIndex: number) => {
      const selection = await shopify.resourcePicker({
        type: "product",
        multiple: false,
      });
      if (!selection || selection.length === 0) return;
      const product: any = selection[0];
      const variant = product.variants?.[0];
      const rawPrice = variant?.price;
      let price = 0;
      if (typeof rawPrice === "number") price = rawPrice;
      else if (typeof rawPrice === "string") price = Number(rawPrice) || 0;
      else if (rawPrice && typeof rawPrice === "object")
        price = Number(rawPrice.amount ?? 0) || 0;
      const item: BundleItem = {
        productId: String(product.id),
        handle: String(product.handle ?? ""),
        title: String(product.title ?? ""),
        price,
        imageUrl: product.images?.[0]?.originalSrc ?? null,
        quantity: 1,
      };
      setTiers((current) =>
        current.map((t, i) =>
          i === tierIndex
            ? { ...t, bundleItems: [...(t.bundleItems ?? []), item] }
            : t,
        ),
      );
    },
    [shopify],
  );

  const updateBundleItem = (
    tierIndex: number,
    itemIndex: number,
    patch: Partial<BundleItem>,
  ) =>
    setTiers((current) =>
      current.map((t, i) =>
        i === tierIndex
          ? {
              ...t,
              bundleItems: (t.bundleItems ?? []).map((b, bi) =>
                bi === itemIndex ? { ...b, ...patch } : b,
              ),
            }
          : t,
      ),
    );

  const removeBundleItem = (tierIndex: number, itemIndex: number) =>
    setTiers((current) =>
      current.map((t, i) =>
        i === tierIndex
          ? {
              ...t,
              bundleItems: (t.bundleItems ?? []).filter(
                (_, bi) => bi !== itemIndex,
              ),
            }
          : t,
      ),
    );

  const removeGift = (tierIndex: number, giftIndex: number) =>
    setTiers((current) =>
      current.map((t, i) =>
        i === tierIndex
          ? { ...t, gifts: (t.gifts ?? []).filter((_, gi) => gi !== giftIndex) }
          : t,
      ),
    );

  const addTier = () => {
    const nextQty =
      tiers.reduce((max, t) => Math.max(max, t.quantity), 0) + 1;
    if (isBxgy) {
      setTiers((current) => [
        ...current,
        {
          quantity: nextQty,
          getQuantity: nextQty,
          discountType: "PERCENT",
          discountValue: 100,
          label: `Buy ${nextQty}, get ${nextQty} free`,
          subtitle: null,
          badgeText: null,
          highlight: false,
        },
      ]);
      return;
    }
    if (offerType === "BUNDLE") {
      setTiers((current) => [
        ...current,
        {
          quantity: 1,
          discountType: "PERCENT",
          discountValue: 20,
          label: "Complete the bundle",
          subtitle: null,
          badgeText: null,
          highlight: false,
          bundleItems: [],
        },
      ]);
      return;
    }
    setTiers((current) => [
      ...current,
      {
        quantity: nextQty,
        discountType: "PERCENT",
        discountValue: 10,
        label: `${nextQty} pcs.`,
        subtitle: null,
        badgeText: null,
        highlight: false,
      },
    ]);
  };

  const removeTier = (index: number) => {
    setTiers((current) => current.filter((_, i) => i !== index));
    // Drop the removed index and shift higher collapsed indices down by one.
    setCollapsedTiers((current) =>
      current
        .filter((i) => i !== index)
        .map((i) => (i > index ? i - 1 : i)),
    );
  };

  // Reorders a break — the array order IS the storefront display order (the
  // metafield and preview both render tiers in this exact order, no re-sort).
  // Used by both drag-and-drop and the up/down buttons.
  const moveTier = (from: number, to: number) => {
    if (to < 0 || to >= tiers.length || from === to) return;
    setTiers((current) => {
      const next = current.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    // Each collapsed/open state needs to follow its tier to the new position,
    // not stay pinned to the old index.
    setCollapsedTiers((current) => {
      const collapsedSet = new Set(current);
      const order = tiers.map((_, i) => i);
      const [movedId] = order.splice(from, 1);
      order.splice(to, 0, movedId);
      return order
        .map((originalIndex, newIndex) =>
          collapsedSet.has(originalIndex) ? newIndex : -1,
        )
        .filter((i) => i >= 0);
    });
  };

  // Drag-and-drop reordering: index of the tier currently being dragged.
  const [dragTierIndex, setDragTierIndex] = useState<number | null>(null);

  const save = () => {
    const formData = new FormData();
    formData.set("intent", "save");
    formData.set("title", title);
    formData.set("type", offerType);
    formData.set("status", status);
    formData.set("headerText", headerText);
    formData.set("productId", productId);
    formData.set("productTitle", productTitle);
    formData.set("imageUrl", imageUrl);
    formData.set("basePrice", basePrice);
    formData.set("tiers", JSON.stringify(tiers));
    formData.set("theme", JSON.stringify(theme));
    submit(formData, { method: "post" });
  };

  const remove = () => {
    const formData = new FormData();
    formData.set("intent", "delete");
    submit(formData, { method: "post" });
  };

  return (
    <>
    <Page
      backAction={{ content: "Your Offers", url: "/app/offers" }}
      title={isNew ? "Create offer" : title || "Edit offer"}
    >
      <TitleBar title={isNew ? "Create offer" : "Edit offer"} />
      <Layout>
        <Layout.Section variant="oneHalf">
          <BlockStack gap="400">
            {!isOfferTypeAvailable(offerType) && (
              <Banner tone="info" title={`${typeMeta?.title ?? "This"} is coming soon`}>
                <p>
                  This discount type isn’t available to configure yet. You can
                  still set up a quantity-breaks offer below in the meantime.
                </p>
              </Banner>
            )}

            {actionData && "errors" in actionData &&
              actionData.errors.length > 0 && (
                <Banner tone="critical" title="Please fix the following">
                  <ul>
                    {actionData.errors.map((error) => (
                      <li key={error}>{error}</li>
                    ))}
                  </ul>
                </Banner>
              )}

            {actionData && "warning" in actionData && actionData.warning && (
              <Banner tone="warning" title="Offer saved, but not live yet">
                <p>{actionData.warning}</p>
              </Banner>
            )}

            {/* Settings — every offer setting grouped into one panel */}
            <Card>
              <BlockStack gap="400">
                <Button
                  variant="plain"
                  fullWidth
                  textAlign="left"
                  disclosure={settingsOpen ? "up" : "down"}
                  onClick={() => setSettingsOpen((open) => !open)}
                >
                  Settings
                </Button>
                <Collapsible
                  open={settingsOpen}
                  id="offer-settings-collapsible"
                  transition={{
                    duration: "200ms",
                    timingFunction: "ease-in-out",
                  }}
                >
                  <BlockStack gap="400">
                <FormLayout>
                  <TextField
                    label="Name (only visible for you)"
                    autoComplete="off"
                    value={title}
                    onChange={setTitle}
                    requiredIndicator
                  />
                  <TextField
                    label="Block title (shown on the widget)"
                    autoComplete="off"
                    value={headerText}
                    onChange={setHeaderText}
                  />
                  <TextField
                    label="Discount name (shown in cart/checkout)"
                    autoComplete="off"
                    value={theme.discountName}
                    onChange={(v) => setSetting("discountName", v)}
                    helpText="Appears as the discount label at cart and checkout."
                  />
                  <Select
                    label="Status"
                    options={[
                      { label: "Draft", value: "DRAFT" },
                      { label: "Active", value: "ACTIVE" },
                      { label: "Archived", value: "ARCHIVED" },
                    ]}
                    value={status}
                    onChange={(value) => setStatus(value as OfferStatus)}
                    helpText="Only Active offers show on the storefront."
                  />
                </FormLayout>

                <Divider />
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">
                    Visibility
                  </Text>
                  <ChoiceList
                    title="Which products"
                    titleHidden
                    choices={[
                      { label: "All products", value: "ALL" },
                      {
                        label: "All products except selected",
                        value: "ALL_EXCEPT",
                      },
                      {
                        label: "Specific selected products",
                        value: "SPECIFIC",
                      },
                      {
                        label: "Products in selected collections",
                        value: "COLLECTIONS",
                      },
                    ]}
                    selected={[theme.visibilityScope]}
                    onChange={(values) =>
                      setSetting(
                        "visibilityScope",
                        values[0] as VisibilityScope,
                      )
                    }
                  />
                  {theme.visibilityScope !== "SPECIFIC" && (
                    <Banner tone="info">
                      <p>
                        Only “Specific selected products” is enforced today. The
                        other scopes are saved but apply in a later update.
                      </p>
                    </Banner>
                  )}
                  {productId ? (
                    <InlineStack gap="300" blockAlign="center">
                      <Thumbnail
                        source={
                          imageUrl ||
                          "https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                        }
                        alt={productTitle}
                        size="small"
                      />
                      <BlockStack gap="050">
                        <Text as="span" fontWeight="medium">
                          {productTitle}
                        </Text>
                        <Text as="span" tone="subdued" variant="bodySm">
                          Base price ${price.toFixed(2)}
                        </Text>
                      </BlockStack>
                      <Button onClick={pickProduct} variant="plain">
                        Change
                      </Button>
                    </InlineStack>
                  ) : (
                    <Button onClick={pickProduct}>Select product</Button>
                  )}
                  <Select
                    label="Markets"
                    options={[{ label: "All", value: "all" }]}
                    value="all"
                    disabled
                    helpText="Market targeting is coming soon."
                  />
                  <Checkbox
                    label="Exclude B2B customers"
                    checked={theme.excludeB2B}
                    onChange={(c) => setSetting("excludeB2B", c)}
                    helpText="Coming soon — saved but not yet enforced."
                  />
                  <Checkbox
                    label="Apply discount only via bundle widget"
                    checked={theme.widgetOnly}
                    onChange={(c) => setSetting("widgetOnly", c)}
                    helpText="Coming soon — saved but not yet enforced."
                  />
                </BlockStack>

                <Divider />
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">
                    Active dates
                  </Text>
                  <FormLayout>
                    <FormLayout.Group>
                      <TextField
                        label="Start date"
                        type="date"
                        autoComplete="off"
                        value={theme.startDate}
                        onChange={(v) => setSetting("startDate", v)}
                      />
                      <TextField
                        label="End date"
                        type="date"
                        autoComplete="off"
                        value={theme.endDate}
                        onChange={(v) => setSetting("endDate", v)}
                        helpText="Leave blank for no end date."
                      />
                    </FormLayout.Group>
                  </FormLayout>
                  <Text as="p" tone="subdued" variant="bodySm">
                    Scheduling is coming soon — dates are saved but not yet
                    enforced.
                  </Text>
                </BlockStack>

                <Divider />
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">
                    Variants
                  </Text>
                  <FormLayout>
                    <Checkbox
                      label="Let customers choose different variants for each item"
                      checked={theme.letChooseVariantPerItem}
                      onChange={(c) =>
                        setSetting("letChooseVariantPerItem", c)
                      }
                      helpText="When a tier is selected, shoppers pick a variant for each item in it (e.g. a different color per unit). Only applies to products with multiple variants."
                    />
                    <Checkbox
                      label="Hide theme variant picker"
                      checked={theme.hideThemeVariantPicker}
                      onChange={(c) => setSetting("hideThemeVariantPicker", c)}
                      helpText="Hides the product page's native variant selector so only the widget's is used."
                    />
                    <Checkbox
                      label="Hide unavailable variant options"
                      checked={theme.hideUnavailableVariants}
                      onChange={(c) => setSetting("hideUnavailableVariants", c)}
                    />
                    <Checkbox
                      label="Don't show other products when a variant is selected"
                      checked={theme.hideOtherProductsOnVariant}
                      onChange={(c) =>
                        setSetting("hideOtherProductsOnVariant", c)
                      }
                      helpText="Coming soon."
                    />
                  </FormLayout>
                  <InlineStack gap="300">
                    <Button
                      onClick={openSwatchModal}
                      disabled={!theme.letChooseVariantPerItem}
                    >
                      Add swatches
                    </Button>
                  </InlineStack>
                  {!theme.letChooseVariantPerItem && (
                    <Text as="p" tone="subdued" variant="bodySm">
                      Enable “Let customers choose different variants for each
                      item” to customize the variant picker style.
                    </Text>
                  )}
                </BlockStack>

                <Divider />
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">
                    Pricing
                  </Text>
                  <FormLayout>
                    <Checkbox
                      label="Show prices per item"
                      checked={theme.showPricePerItem}
                      onChange={(c) => setSetting("showPricePerItem", c)}
                      helpText="Adds a per-unit price under each tier’s total."
                    />
                    <Checkbox
                      label="Show compare-at price"
                      checked={theme.showCompareAt}
                      onChange={(c) => setSetting("showCompareAt", c)}
                      helpText="Shows the struck-through original price."
                    />
                    <Checkbox
                      label="Show prices without decimals"
                      checked={theme.hidePriceDecimals}
                      onChange={(c) => setSetting("hidePriceDecimals", c)}
                      helpText="Coming soon."
                    />
                    <Checkbox
                      label="Price rounding"
                      checked={theme.priceRounding}
                      onChange={(c) => setSetting("priceRounding", c)}
                      helpText="Coming soon."
                    />
                    <Checkbox
                      label="Update theme product price"
                      checked={theme.updateThemePrice}
                      onChange={(c) => setSetting("updateThemePrice", c)}
                      helpText="Coming soon."
                    />
                  </FormLayout>
                </BlockStack>

                <Divider />
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">
                    Display
                  </Text>
                  <Select
                    label="Default selected tier"
                    options={[
                      { label: "Auto (Most popular, else first)", value: "" },
                      ...tiers.map((tier) => ({
                        label: `${
                          tier.label ||
                          (isBxgy
                            ? `Buy ${tier.quantity}, get ${tier.getQuantity ?? 1} free`
                            : `${tier.quantity} pcs.`)
                        }${tier.highlight ? " — Most popular" : ""}`,
                        value: String(tier.quantity),
                      })),
                    ]}
                    value={
                      theme.defaultTierQuantity === null
                        ? ""
                        : String(theme.defaultTierQuantity)
                    }
                    onChange={(value) =>
                      setSetting(
                        "defaultTierQuantity",
                        value === "" ? null : Number(value),
                      )
                    }
                    helpText="Which option is pre-selected when the widget loads."
                  />
                </BlockStack>

                <Divider />
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h3" variant="headingSm">
                      Low stock alert
                    </Text>
                    <Checkbox
                      labelHidden
                      label="Low stock alert"
                      checked={theme.lowStockAlert}
                      onChange={(c) => setSetting("lowStockAlert", c)}
                    />
                  </InlineStack>
                  <Text as="p" tone="subdued" variant="bodySm">
                    Coming soon — shows a low-stock message in the widget.
                  </Text>
                </BlockStack>
                  </BlockStack>
                </Collapsible>
              </BlockStack>
            </Card>

            {/* Styles — colors + fonts/layout grouped into one panel */}
            <Card>
              <BlockStack gap="400">
                <Button
                  variant="plain"
                  fullWidth
                  textAlign="left"
                  disclosure={stylesOpen ? "up" : "down"}
                  onClick={() => setStylesOpen((open) => !open)}
                >
                  Styles
                </Button>
                <Collapsible
                  open={stylesOpen}
                  id="offer-styles-collapsible"
                  transition={{
                    duration: "200ms",
                    timingFunction: "ease-in-out",
                  }}
                >
                  <BlockStack gap="400">
                    <BlockStack gap="300">
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="h3" variant="headingSm">
                          Colors
                        </Text>
                        <Button
                          variant="plain"
                          onClick={() => setTheme(normalizeTheme(null))}
                        >
                          Reset to defaults
                        </Button>
                      </InlineStack>
                      <Text as="p" tone="subdued" variant="bodySm">
                        Pick a color for each part of the storefront widget.
                        Changes show live in the preview.
                      </Text>
                      <FormLayout>
                        {chunk(THEME_FIELDS, 2).map((row, rowIndex) => (
                          <FormLayout.Group condensed key={rowIndex}>
                            {row.map((field) => (
                              <ColorField
                                key={field.key}
                                label={field.label}
                                value={theme[field.key]}
                                onChange={(value) => setColor(field.key, value)}
                              />
                            ))}
                          </FormLayout.Group>
                        ))}
                      </FormLayout>
                    </BlockStack>

                    <Divider />
                    <BlockStack gap="300">
                      <Text as="h3" variant="headingSm">
                        Fonts & layout
                      </Text>
                      <FormLayout>
                        <FormLayout.Group>
                          <Select
                            label="Font"
                            options={FONT_OPTIONS}
                            value={theme.fontFamily}
                            onChange={(value) => setSetting("fontFamily", value)}
                            helpText="“Theme default” uses your store's own font."
                          />
                          <TextField
                            label="Base font size (px)"
                            type="number"
                            min={10}
                            max={28}
                            autoComplete="off"
                            value={String(theme.fontSize)}
                            onChange={(value) =>
                              setSetting(
                                "fontSize",
                                Math.max(10, Number(value) || 14),
                              )
                            }
                          />
                        </FormLayout.Group>
                        <FormLayout.Group>
                          <RangeSlider
                            label="Tier corner radius"
                            min={0}
                            max={40}
                            value={theme.tierRadius}
                            onChange={(value) =>
                              setSetting(
                                "tierRadius",
                                Array.isArray(value) ? value[0] : value,
                              )
                            }
                            output
                            suffix={
                              <Text as="span" variant="bodySm" tone="subdued">
                                {theme.tierRadius}px
                              </Text>
                            }
                          />
                        </FormLayout.Group>
                      </FormLayout>
                    </BlockStack>
                  </BlockStack>
                </Collapsible>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    {isBxgy
                      ? "Buy X, get Y tiers"
                      : offerType === "BUNDLE"
                        ? "Bundle breaks"
                        : "Quantity tiers"}
                  </Text>
                  <Button onClick={addTier}>Add tier</Button>
                </InlineStack>
                {isBxgy && (
                  <Text as="p" tone="subdued" variant="bodySm">
                    Each tier adds the buy + get quantity of this product to the
                    cart; the discount below is applied to the “get” units
                    (100% = free).
                  </Text>
                )}
                {offerType === "BUNDLE" && (
                  <Text as="p" tone="subdued" variant="bodySm">
                    Add products to a break below to make it a “complete the
                    bundle” — they’re added together with this product and
                    discounted as a whole. Breaks left without products behave
                    as normal quantity tiers.
                  </Text>
                )}

                {tiers.map((tier, index) => {
                  const isBundleTier = (tier.bundleItems ?? []).length > 0;
                  const summary =
                    tier.label ||
                    (isBundleTier
                      ? "Complete the bundle"
                      : isBxgy
                        ? `Buy ${tier.quantity}, get ${tier.getQuantity ?? 1} free`
                        : `${tier.quantity} pcs.`);
                  return (
                    <Box
                      key={index}
                      padding="300"
                      borderColor="border"
                      borderWidth="025"
                      borderRadius="200"
                      background={
                        dragTierIndex === index ? "bg-surface-active" : undefined
                      }
                    >
                      <BlockStack gap="300">
                        <div
                          draggable
                          onDragStart={(e) => {
                            setDragTierIndex(index);
                            e.dataTransfer.effectAllowed = "move";
                          }}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => {
                            e.preventDefault();
                            if (dragTierIndex !== null && dragTierIndex !== index) {
                              moveTier(dragTierIndex, index);
                            }
                            setDragTierIndex(null);
                          }}
                          onDragEnd={() => setDragTierIndex(null)}
                          style={{ display: "flex", alignItems: "center", gap: 4 }}
                        >
                          <span
                            aria-hidden="true"
                            title="Drag to reorder"
                            style={{
                              cursor: "grab",
                              color: "#8a8a8a",
                              fontSize: 16,
                              letterSpacing: -2,
                              lineHeight: 1,
                              padding: "0 6px",
                              userSelect: "none",
                              flex: "0 0 auto",
                            }}
                          >
                            ⠿⠿
                          </span>
                          <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                            <Button
                              variant="plain"
                              fullWidth
                              textAlign="left"
                              disclosure={isTierOpen(index) ? "up" : "down"}
                              onClick={() => toggleTier(index)}
                            >
                              {summary}
                              {tier.highlight ? " · Most popular" : ""}
                            </Button>
                          </div>
                          <div style={{ display: "flex", flex: "0 0 auto" }}>
                            <Button
                              variant="tertiary"
                              size="micro"
                              accessibilityLabel={`Move "${summary}" up`}
                              onClick={() => moveTier(index, index - 1)}
                              disabled={index === 0}
                            >
                              ↑
                            </Button>
                            <Button
                              variant="tertiary"
                              size="micro"
                              accessibilityLabel={`Move "${summary}" down`}
                              onClick={() => moveTier(index, index + 1)}
                              disabled={index === tiers.length - 1}
                            >
                              ↓
                            </Button>
                          </div>
                        </div>
                        <Collapsible
                          open={isTierOpen(index)}
                          id={`tier-collapsible-${index}`}
                        >
                          <BlockStack gap="300">
                      <FormLayout>
                        <FormLayout.Group condensed>
                          <TextField
                            label={
                              isBxgy
                                ? "Buy quantity"
                                : isBundleTier
                                  ? "Main product qty"
                                  : "Quantity"
                            }
                            type="number"
                            min={1}
                            autoComplete="off"
                            value={String(tier.quantity)}
                            onChange={(v) =>
                              updateTier(index, {
                                quantity: Math.max(1, Number(v)),
                              })
                            }
                          />
                          {isBxgy && (
                            <TextField
                              label="Get quantity"
                              type="number"
                              min={1}
                              autoComplete="off"
                              value={String(tier.getQuantity ?? 1)}
                              onChange={(v) =>
                                updateTier(index, {
                                  getQuantity: Math.max(1, Number(v)),
                                })
                              }
                            />
                          )}
                          <Select
                            label={
                              isBxgy
                                ? "Get-item discount"
                                : isBundleTier
                                  ? "Bundle discount"
                                  : "Discount"
                            }
                            options={DISCOUNT_OPTIONS}
                            value={tier.discountType}
                            onChange={(v) =>
                              updateTier(index, {
                                discountType: v as DiscountType,
                              })
                            }
                          />
                          <TextField
                            label={
                              tier.discountType === "PERCENT"
                                ? "Percent"
                                : "Amount"
                            }
                            type="number"
                            min={0}
                            autoComplete="off"
                            disabled={tier.discountType === "NONE"}
                            value={String(tier.discountValue)}
                            onChange={(v) =>
                              updateTier(index, { discountValue: Number(v) })
                            }
                          />
                        </FormLayout.Group>
                        <FormLayout.Group condensed>
                          <TextField
                            label="Label"
                            autoComplete="off"
                            value={tier.label ?? ""}
                            onChange={(v) => updateTier(index, { label: v })}
                          />
                          <TextField
                            label="Subtitle"
                            autoComplete="off"
                            value={tier.subtitle ?? ""}
                            onChange={(v) =>
                              updateTier(index, { subtitle: v })
                            }
                          />
                          <TextField
                            label="Badge"
                            autoComplete="off"
                            placeholder="MOST POPULAR"
                            value={tier.badgeText ?? ""}
                            onChange={(v) =>
                              updateTier(index, { badgeText: v })
                            }
                          />
                        </FormLayout.Group>
                      </FormLayout>
                      <InlineStack align="space-between" blockAlign="center">
                        <Checkbox
                          label="Highlight as Most popular"
                          checked={tier.highlight}
                          onChange={(checked) =>
                            updateTier(index, { highlight: checked })
                          }
                        />
                        <Button
                          variant="plain"
                          tone="critical"
                          onClick={() => removeTier(index)}
                          disabled={tiers.length <= 1}
                        >
                          Remove
                        </Button>
                      </InlineStack>
                      <Divider />
                      <BlockStack gap="200">
                        <Text as="span" variant="headingSm">
                          Bundle products
                        </Text>
                        <Text as="p" tone="subdued" variant="bodySm">
                          Add products to make this break a “complete the
                          bundle” — they’re added together and discounted by
                          this break’s percentage. Leave empty for a normal
                          quantity break.
                        </Text>
                        {(tier.bundleItems ?? []).map((item, bi) => (
                          <InlineStack
                            key={bi}
                            align="space-between"
                            blockAlign="center"
                            gap="200"
                          >
                            <InlineStack gap="200" blockAlign="center">
                              {item.imageUrl && (
                                <Thumbnail
                                  source={item.imageUrl}
                                  alt={item.title}
                                  size="small"
                                />
                              )}
                              <Text as="span" variant="bodyMd">
                                {item.title}{" "}
                                <Text as="span" tone="subdued">
                                  (${item.price.toFixed(2)})
                                </Text>
                              </Text>
                            </InlineStack>
                            <InlineStack gap="200" blockAlign="center">
                              <Box width="80px">
                                <TextField
                                  label="Qty"
                                  labelHidden
                                  type="number"
                                  min={1}
                                  autoComplete="off"
                                  prefix="×"
                                  value={String(item.quantity ?? 1)}
                                  onChange={(v) =>
                                    updateBundleItem(index, bi, {
                                      quantity: Math.max(1, Number(v) || 1),
                                    })
                                  }
                                />
                              </Box>
                              <Button
                                variant="plain"
                                tone="critical"
                                onClick={() => removeBundleItem(index, bi)}
                              >
                                Remove
                              </Button>
                            </InlineStack>
                          </InlineStack>
                        ))}
                        <div>
                          <Button onClick={() => addBundleItem(index)}>
                            Add bundle product
                          </Button>
                        </div>
                      </BlockStack>
                      <Divider />
                      <BlockStack gap="200">
                        <Text as="span" variant="headingSm">
                          Free gifts
                        </Text>
                        <Text as="p" tone="subdued" variant="bodySm">
                          Added free to the cart when a customer buys this tier
                          (or a higher one).
                        </Text>
                        {(tier.gifts ?? []).map((gift, gi) => (
                          <InlineStack
                            key={gi}
                            align="space-between"
                            blockAlign="center"
                            gap="200"
                          >
                            <InlineStack gap="200" blockAlign="center">
                              {gift.imageUrl && (
                                <Thumbnail
                                  source={gift.imageUrl}
                                  alt={gift.title}
                                  size="small"
                                />
                              )}
                              <Text as="span" variant="bodyMd">
                                + FREE {gift.title}
                              </Text>
                            </InlineStack>
                            <InlineStack gap="200" blockAlign="center">
                              <Box width="110px">
                                <TextField
                                  label="Original price"
                                  labelHidden
                                  type="number"
                                  min={0}
                                  step={0.01}
                                  autoComplete="off"
                                  prefix="$"
                                  value={String(gift.price ?? 0)}
                                  onChange={(v) =>
                                    updateGift(index, gi, {
                                      price: Math.max(0, Number(v) || 0),
                                    })
                                  }
                                />
                              </Box>
                              <Box width="80px">
                                <TextField
                                  label="Qty"
                                  labelHidden
                                  type="number"
                                  min={1}
                                  autoComplete="off"
                                  prefix="×"
                                  value={String(gift.quantity ?? 1)}
                                  onChange={(v) =>
                                    updateGift(index, gi, {
                                      quantity: Math.max(1, Number(v) || 1),
                                    })
                                  }
                                />
                              </Box>
                              <Checkbox
                                label="Per item"
                                checked={gift.perUnit === true}
                                onChange={(c) =>
                                  updateGift(index, gi, { perUnit: c })
                                }
                              />
                              <Button
                                variant="plain"
                                tone="critical"
                                onClick={() => removeGift(index, gi)}
                              >
                                Remove
                              </Button>
                            </InlineStack>
                          </InlineStack>
                        ))}
                        <div>
                          <Button onClick={() => addGift(index)}>
                            Add free gift
                          </Button>
                        </div>
                      </BlockStack>
                          </BlockStack>
                        </Collapsible>
                      </BlockStack>
                    </Box>
                  );
                })}
              </BlockStack>
            </Card>

            {/* Countdown timer */}
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Button
                    variant="plain"
                    textAlign="left"
                    disclosure={countdownOpen ? "up" : "down"}
                    onClick={() => setCountdownOpen((open) => !open)}
                  >
                    Countdown timer
                  </Button>
                  <Checkbox
                    labelHidden
                    label="Enable countdown timer"
                    checked={theme.countdownEnabled}
                    onChange={(c) => setSetting("countdownEnabled", c)}
                  />
                </InlineStack>
                <Collapsible
                  open={countdownOpen}
                  id="offer-countdown-collapsible"
                  transition={{
                    duration: "200ms",
                    timingFunction: "ease-in-out",
                  }}
                >
                  <BlockStack gap="300">
                    <ChoiceList
                      title="Timer mode"
                      choices={[
                        { label: "Fixed duration", value: "FIXED" },
                        {
                          label: "Ends at midnight (visitor's local time)",
                          value: "MIDNIGHT",
                        },
                        { label: "Custom end date", value: "DATE" },
                      ]}
                      selected={[theme.countdownMode]}
                      onChange={(v) =>
                        setSetting("countdownMode", v[0] as CountdownMode)
                      }
                    />
                    {theme.countdownMode === "FIXED" && (
                      <TextField
                        label="Duration (minutes)"
                        type="number"
                        min={1}
                        autoComplete="off"
                        value={String(theme.countdownMinutes)}
                        onChange={(v) =>
                          setSetting(
                            "countdownMinutes",
                            Math.max(1, Number(v) || 15),
                          )
                        }
                        helpText="Evergreen timer that restarts for each visitor."
                      />
                    )}
                    {theme.countdownMode === "DATE" && (
                      <TextField
                        label="End date & time"
                        type="datetime-local"
                        autoComplete="off"
                        value={theme.countdownEndDate}
                        onChange={(v) => setSetting("countdownEndDate", v)}
                      />
                    )}
                    <TextField
                      label="Title"
                      autoComplete="off"
                      value={theme.countdownTitle}
                      onChange={(v) => setSetting("countdownTitle", v)}
                      helpText="Use {{timer}} where the countdown should appear."
                    />
                    <FormLayout>
                      <FormLayout.Group condensed>
                        <ColorField
                          label="Background"
                          value={theme.countdownBgColor}
                          onChange={(v) => setSetting("countdownBgColor", v)}
                        />
                        <ColorField
                          label="Text"
                          value={theme.countdownTextColor}
                          onChange={(v) => setSetting("countdownTextColor", v)}
                        />
                      </FormLayout.Group>
                      <FormLayout.Group condensed>
                        <Select
                          label="Alignment"
                          options={[
                            { label: "Left", value: "left" },
                            { label: "Center", value: "center" },
                            { label: "Right", value: "right" },
                          ]}
                          value={theme.countdownAlign}
                          onChange={(v) =>
                            setSetting(
                              "countdownAlign",
                              v as CountdownAlignment,
                            )
                          }
                        />
                        <TextField
                          label="Size (px)"
                          type="number"
                          min={8}
                          max={40}
                          autoComplete="off"
                          value={String(theme.countdownFontSize)}
                          onChange={(v) =>
                            setSetting(
                              "countdownFontSize",
                              Math.max(8, Number(v) || 13),
                            )
                          }
                        />
                        <TextField
                          label="Corner radius (px)"
                          type="number"
                          min={0}
                          max={40}
                          autoComplete="off"
                          value={String(theme.countdownRadius)}
                          onChange={(v) =>
                            setSetting(
                              "countdownRadius",
                              Math.max(0, Number(v) || 0),
                            )
                          }
                        />
                        <TextField
                          label="Padding (px)"
                          type="number"
                          min={0}
                          max={40}
                          autoComplete="off"
                          value={String(theme.countdownPadding)}
                          onChange={(v) =>
                            setSetting(
                              "countdownPadding",
                              Math.max(0, Number(v) || 0),
                            )
                          }
                        />
                      </FormLayout.Group>
                    </FormLayout>
                    <InlineStack gap="400">
                      <Checkbox
                        label="Bold"
                        checked={theme.countdownBold}
                        onChange={(c) => setSetting("countdownBold", c)}
                      />
                      <Checkbox
                        label="Italic"
                        checked={theme.countdownItalic}
                        onChange={(c) => setSetting("countdownItalic", c)}
                      />
                    </InlineStack>
                  </BlockStack>
                </Collapsible>
              </BlockStack>
            </Card>

          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneHalf">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Storefront preview
                </Text>
                <Divider />
                <WidgetPreview
                  type={offerType}
                  headerText={headerText}
                  basePrice={price}
                  tiers={tiers}
                  theme={theme}
                  productOptions={productOptions}
                  productTitle={productTitle || "Product"}
                  productImageUrl={imageUrl || null}
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Activate embed</Text>
                <Divider />
                <Text as="p" variant="bodyMd" tone="subdued">
                  The widget appears on your storefront only when the Bundley
                  app embed is enabled in your theme. Click below to open the
                  Theme Editor — then toggle <strong>Bundley</strong> on under
                  App embeds.
                </Text>
                <Button
                  url={`https://${shop}/admin/themes/current/editor?context=apps`}
                  target="_blank"
                  fullWidth
                >
                  Open Theme Editor → App embeds
                </Button>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Button
                  variant="primary"
                  loading={isSaving}
                  onClick={save}
                  fullWidth
                >
                  {isNew ? "Create offer" : "Save offer"}
                </Button>
                {!isNew && (
                  <Button
                    variant="primary"
                    tone="critical"
                    onClick={remove}
                    fullWidth
                  >
                    Delete offer
                  </Button>
                )}
                <Button onClick={() => navigate("/app/offers")} fullWidth>
                  Cancel
                </Button>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
    <Modal
      open={swatchModalOpen}
      onClose={() => setSwatchModalOpen(false)}
      title="Add swatches to variant picker"
      primaryAction={{ content: "Apply", onAction: applySwatchModal }}
      secondaryActions={[
        { content: "Cancel", onAction: () => setSwatchModalOpen(false) },
      ]}
    >
      <Modal.Section>
        <InlineStack gap="500" align="space-between" wrap={false} blockAlign="start">
          <Box minWidth="240px">
            <BlockStack gap="400">
              <Text as="h3" variant="headingSm">
                Swatches
              </Text>
              <Select
                label="Option"
                options={
                  productOptions.length > 0
                    ? productOptions.map((o) => ({
                        label: o.name,
                        value: o.name,
                      }))
                    : [{ label: "Color", value: "" }]
                }
                value={draftOption}
                onChange={setDraftOption}
                disabled={productOptions.length === 0}
                helpText={
                  productOptions.length === 0
                    ? "Pick a product to load its real options."
                    : "The picker style applies to all options."
                }
              />
              <Select
                label="Type"
                options={[
                  { label: "Default dropdown", value: "dropdown" },
                  { label: "Color swatch", value: "color" },
                  { label: "Button swatch", value: "button" },
                ]}
                value={draftPickerType}
                onChange={(v) => setDraftPickerType(v as VariantPickerType)}
                helpText="How each item's variant picker looks in the bars."
              />
              {draftPickerType !== "dropdown" && (
                <RangeSlider
                  label="Swatch size"
                  min={20}
                  max={64}
                  value={draftSwatchSize}
                  onChange={(value) =>
                    setDraftSwatchSize(
                      Array.isArray(value) ? value[0] : value,
                    )
                  }
                  output
                  suffix={
                    <Text as="span" variant="bodySm" tone="subdued">
                      {draftSwatchSize}px
                    </Text>
                  }
                />
              )}
              {draftPickerType === "color" && swatchValues.length > 0 && (
                <BlockStack gap="200">
                  <Text as="span" variant="headingSm">
                    Colors for {swatchOptionName}
                  </Text>
                  {swatchValues.map((val) => (
                    <InlineStack
                      key={val}
                      align="space-between"
                      blockAlign="center"
                    >
                      <Text as="span" variant="bodyMd">
                        {val}
                      </Text>
                      <input
                        type="color"
                        aria-label={`Color for ${val}`}
                        value={draftSwatchColors[val] || "#cccccc"}
                        onChange={(e) =>
                          setDraftSwatchColors((c) => ({
                            ...c,
                            [val]: e.target.value,
                          }))
                        }
                        style={{
                          width: 44,
                          height: 30,
                          padding: 0,
                          border: "1px solid #ccc",
                          borderRadius: 6,
                          background: "none",
                          cursor: "pointer",
                        }}
                      />
                    </InlineStack>
                  ))}
                </BlockStack>
              )}
            </BlockStack>
          </Box>
          <Box minWidth="280px">
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">
                Preview
              </Text>
              <SwatchPreview
                theme={theme}
                pickerType={draftPickerType}
                swatchSize={draftSwatchSize}
                optionName={swatchOptionName}
                values={swatchValues}
                colors={draftSwatchColors}
              />
            </BlockStack>
          </Box>
        </InlineStack>
      </Modal.Section>
    </Modal>
    </>
  );
}

const SAMPLE_VALUES = ["Black", "White", "Navy"];
const SAMPLE_COLORS: Record<string, string> = {
  Black: "#1a1a1a",
  White: "#ffffff",
  Navy: "#1e3a8a",
};

// Best-effort CSS color for a swatch preview: known samples first, otherwise
// the value used directly as a CSS color (mirrors the storefront).
function colorFor(value: string): string {
  return SAMPLE_COLORS[value] ?? value.toLowerCase().replace(/\s+/g, "");
}

// Mock per-item variant picker for the editor previews, rendered in the chosen
// style: dropdown / color swatches / button swatches. Uses the real product
// option name + values when available (placeholder sample otherwise).
function VariantPickerMock({
  theme,
  pickerType,
  swatchSize,
  units,
  optionName,
  values,
  colors,
}: {
  theme: WidgetTheme;
  pickerType: VariantPickerType;
  swatchSize: number;
  units: number;
  optionName: string;
  values: string[];
  colors?: Record<string, string>;
}) {
  const vals = values.length > 0 ? values : SAMPLE_VALUES;
  const swatchColor = (v: string) => colors?.[v] || colorFor(v);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        borderTop: `1px solid ${theme.borderColor}`,
        paddingTop: 10,
      }}
    >
      <span
        style={{
          fontSize: "0.72em",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: theme.subtitleColor,
        }}
      >
        {optionName}
      </span>
      {Array.from({ length: Math.max(1, units) }).map((_, u) => (
        <div
          key={u}
          style={{ display: "flex", alignItems: "center", gap: 8 }}
        >
          <span
            style={{
              fontSize: "0.86em",
              fontWeight: 600,
              color: theme.subtitleColor,
              minWidth: "1.6em",
            }}
          >
            #{u + 1}
          </span>
          {pickerType === "dropdown" ? (
            <select
              disabled
              style={{
                flex: 1,
                fontSize: "0.86em",
                color: theme.labelColor,
                background: "#fff",
                border: `1.5px solid ${theme.borderColor}`,
                borderRadius: 8,
                padding: "6px 10px",
              }}
            >
              {vals.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          ) : (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {vals.map((v, i) =>
                pickerType === "color" ? (
                  <span
                    key={v}
                    title={v}
                    style={{
                      width: swatchSize,
                      height: swatchSize,
                      borderRadius: "50%",
                      background: swatchColor(v),
                      boxShadow:
                        i === 0
                          ? `0 0 0 2px #fff, 0 0 0 4px ${theme.accentColor}`
                          : "inset 0 0 0 1px rgba(0,0,0,0.15)",
                    }}
                  />
                ) : (
                  <span
                    key={v}
                    style={{
                      minWidth: swatchSize,
                      height: swatchSize * 0.78,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: "0 14px",
                      borderRadius: 8,
                      fontSize: "0.86em",
                      fontWeight: 600,
                      color: theme.labelColor,
                      background: i === 0 ? theme.selectedBgColor : "#fff",
                      border: `1.5px solid ${
                        i === 0 ? theme.accentColor : theme.borderColor
                      }`,
                    }}
                  >
                    {v}
                  </span>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// The "Add swatches" modal's live preview: a sample selected bar with the
// chosen picker style.
function SwatchPreview({
  theme,
  pickerType,
  swatchSize,
  optionName,
  values,
  colors,
}: {
  theme: WidgetTheme;
  pickerType: VariantPickerType;
  swatchSize: number;
  optionName: string;
  values: string[];
  colors?: Record<string, string>;
}) {
  return (
    <div
      style={{
        border: `2px solid ${theme.accentColor}`,
        borderRadius: theme.tierRadius,
        padding: "12px 14px",
        background: theme.selectedBgColor,
        fontFamily:
          theme.fontFamily === "inherit" ? undefined : theme.fontFamily,
        fontSize: theme.fontSize,
        maxWidth: 320,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div style={{ fontWeight: 700, color: theme.labelColor }}>Duo</div>
        <div style={{ fontWeight: 700, color: theme.priceColor }}>$68.00</div>
      </div>
      <VariantPickerMock
        theme={theme}
        pickerType={pickerType}
        swatchSize={swatchSize}
        units={2}
        optionName={optionName}
        values={values}
        colors={colors}
      />
    </div>
  );
}

function WidgetPreview({
  type,
  headerText,
  basePrice,
  tiers,
  theme,
  productOptions,
  productTitle,
  productImageUrl,
}: {
  type: OfferType;
  headerText: string;
  basePrice: number;
  tiers: TierInput[];
  theme: WidgetTheme;
  productOptions: ProductOption[];
  productTitle: string;
  productImageUrl: string | null;
}) {
  const isBxgy = type === "BXGY";
  const firstOption = productOptions[0];
  const previewOptionName = firstOption?.name ?? "Color";
  const previewValues =
    firstOption && firstOption.values.length > 0
      ? firstOption.values
      : SAMPLE_VALUES;

  // Live ticking countdown for the preview (mirrors the storefront timer).
  const [now, setNow] = useState(() => Date.now());
  const countdownMountRef = useRef(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  let countdownRemaining: number;
  if (theme.countdownMode === "DATE" && theme.countdownEndDate) {
    const t = new Date(theme.countdownEndDate).getTime();
    countdownRemaining = isNaN(t) ? 0 : t - now;
  } else if (theme.countdownMode === "MIDNIGHT") {
    const midnight = new Date();
    midnight.setHours(24, 0, 0, 0);
    countdownRemaining = midnight.getTime() - now;
  } else {
    const totalMs = Math.max(1, theme.countdownMinutes) * 60000;
    countdownRemaining = totalMs - ((now - countdownMountRef.current) % totalMs);
  }
  const countdownText = formatCountdown(countdownRemaining);

  // The metafield preserves the merchant's own tier order (drag-to-reorder in
  // the dashboard) — mirror that here unchanged so the preview matches what
  // actually renders on the storefront.
  const previewTiers = tiers;

  // Mirror the storefront selection rule: explicit default tier first, then
  // the highlighted tier, then the first tier.
  const byDefault =
    theme.defaultTierQuantity === null
      ? -1
      : previewTiers.findIndex((t) => t.quantity === theme.defaultTierQuantity);
  const byHighlight = previewTiers.findIndex((t) => t.highlight);
  const selectedIndex = byDefault >= 0 ? byDefault : Math.max(0, byHighlight);

  return (
    <div
      style={{
        border: "1px solid #e3e3e3",
        borderRadius: 16,
        padding: 16,
        background: "#fff",
        fontFamily:
          theme.fontFamily === "inherit" ? undefined : theme.fontFamily,
        fontSize: theme.fontSize,
      }}
    >
      {headerText && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            fontWeight: 700,
            fontSize: "0.86em",
            letterSpacing: 1,
            textTransform: "uppercase",
            color: theme.headerColor,
            marginBottom: 12,
          }}
        >
          <span
            style={{ flex: "1 1 auto", height: 1, background: theme.accentColor }}
          />
          {headerText}
          <span
            style={{ flex: "1 1 auto", height: 1, background: theme.accentColor }}
          />
        </div>
      )}
      {theme.countdownEnabled && (
        <div
          style={{
            background: theme.countdownBgColor,
            color: theme.countdownTextColor,
            textAlign: theme.countdownAlign,
            fontSize: theme.countdownFontSize,
            fontWeight: theme.countdownBold ? 700 : undefined,
            fontStyle: theme.countdownItalic ? "italic" : undefined,
            padding: `${theme.countdownPadding}px 12px`,
            borderRadius: theme.countdownRadius,
            marginBottom: 12,
          }}
        >
          {theme.countdownTitle.replace(/\{\{\s*timer\s*\}\}/g, countdownText)}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {previewTiers.map((tier, index) => {
          const isBundleTier = (tier.bundleItems ?? []).length > 0;
          const pricing = isBxgy
            ? computeBxgyPricing(basePrice, tier)
            : computeAnyTierPricing(basePrice, tier);
          const labelFallback = isBundleTier
            ? "Complete the bundle"
            : isBxgy
              ? `Buy ${tier.quantity}, get ${tier.getQuantity ?? 1} free`
              : `${tier.quantity} pcs.`;
          const selected = index === selectedIndex;
          // Only the SELECTED tier gets the accent border — a highlighted
          // (e.g. "MOST POPULAR") tier keeps its badge but stays neutral
          // until chosen, matching the storefront's .qb-tier--selected rule.
          const accented = selected;
          const hasGifts = (tier.gifts ?? []).length > 0;
          const hasVariantPanel =
            selected && theme.letChooseVariantPerItem && !isBundleTier;
          // The bundle panel (like gifts) is always present in the DOM — just
          // hidden when the tier isn't selected — so its bottom-corner squaring
          // is unconditional too, matching the storefront's :has(.qb-bundle)
          // CSS rule that doesn't care about visibility.
          const squareBottom = hasGifts || isBundleTier || hasVariantPanel;
          return (
            <div
              key={index}
              style={{ display: "flex", flexDirection: "column" }}
            >
            <div
              style={{
                position: "relative",
                border: `2px solid ${accented ? theme.accentColor : theme.borderColor}`,
                borderRadius: squareBottom
                  ? `${theme.tierRadius}px ${theme.tierRadius}px 0 0`
                  : theme.tierRadius,
                padding: "12px 14px",
                display: "flex",
                flexDirection: "column",
                gap: 12,
                background: selected ? theme.selectedBgColor : "#fff",
              }}
            >
              {tier.badgeText && (
                <span
                  style={{
                    position: "absolute",
                    top: -10,
                    right: 12,
                    background: theme.badgeBgColor,
                    color: theme.badgeTextColor,
                    fontSize: "0.72em",
                    fontWeight: 700,
                    padding: "2px 8px",
                    borderRadius: 6,
                    letterSpacing: 0.5,
                  }}
                >
                  {tier.badgeText}
                </span>
              )}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: "50%",
                    border: `2px solid ${selected ? theme.accentColor : "#bbb"}`,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {selected && (
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: theme.accentColor,
                      }}
                    />
                  )}
                </span>
                <div>
                  <div
                    style={{
                      fontWeight: 700,
                      fontSize: "1em",
                      color: theme.labelColor,
                    }}
                  >
                    {tier.label || labelFallback}
                  </div>
                  <div style={{ fontSize: "0.86em", color: theme.subtitleColor }}>
                    {tier.subtitle ||
                      (pricing.savingsPercent > 0
                        ? `You save ${pricing.savingsPercent.toFixed(0)}%`
                        : " ")}
                  </div>
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div
                  style={{
                    fontWeight: 700,
                    fontSize: "1em",
                    color: theme.priceColor,
                  }}
                >
                  ${pricing.total.toFixed(2)}
                </div>
                {pricing.savings > 0 && (
                  <div
                    style={{
                      fontSize: "0.86em",
                      color: theme.compareAtColor,
                      textDecoration: "line-through",
                    }}
                  >
                    ${pricing.compareAt.toFixed(2)}
                  </div>
                )}
              </div>
              </div>
              {!isBundleTier && hasVariantPanel && (
                <VariantPickerMock
                  theme={theme}
                  pickerType={theme.variantPickerType}
                  swatchSize={theme.swatchSize}
                  units={
                    isBxgy
                      ? tier.quantity + (tier.getQuantity ?? 0)
                      : tier.quantity
                  }
                  optionName={previewOptionName}
                  values={previewValues}
                  colors={theme.swatchColors}
                />
              )}
            </div>
              {isBundleTier && selected && (() => {
                const mainUnit = tierUnitPrice(basePrice, tier);
                const mainCard = (title: string, imageUrl: string | null, discounted: number, compareAt: number) => (
                  <div
                    style={{
                      flex: "1 1 0",
                      minWidth: 90,
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 6,
                      textAlign: "center" as const,
                      fontSize: "0.82em",
                    }}
                  >
                    {imageUrl && (
                      <img
                        src={imageUrl}
                        alt=""
                        width={80}
                        height={80}
                        style={{
                          borderRadius: 8,
                          objectFit: "cover",
                          border: `1px solid ${theme.borderColor}`,
                        }}
                      />
                    )}
                    <span style={{ fontWeight: 600, color: theme.labelColor, lineHeight: 1.3 }}>
                      {title}
                    </span>
                    <span
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 4,
                        flexWrap: "wrap",
                      }}
                    >
                      {discounted < compareAt && (
                        <span
                          style={{
                            color: theme.compareAtColor,
                            textDecoration: "line-through",
                          }}
                        >
                          ${compareAt.toFixed(2)}
                        </span>
                      )}
                      <span style={{ color: theme.priceColor }}>
                        ${discounted.toFixed(2)}
                      </span>
                    </span>
                  </div>
                );
                return (
                  <div
                    style={{
                      background: "#fff",
                      border: `2px solid ${theme.accentColor}`,
                      borderTop: "none",
                      borderRadius: `0 0 ${theme.tierRadius}px ${theme.tierRadius}px`,
                      padding: "12px 14px",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
                      <div style={{ flex: "1 1 0", minWidth: 90, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                        {mainCard(
                          productTitle,
                          productImageUrl,
                          mainUnit,
                          basePrice,
                        )}
                        {theme.letChooseVariantPerItem && (
                          <VariantPickerMock
                            theme={theme}
                            pickerType={theme.variantPickerType}
                            swatchSize={theme.swatchSize}
                            units={tier.quantity}
                            optionName={previewOptionName}
                            values={previewValues}
                            colors={theme.swatchColors}
                          />
                        )}
                      </div>
                      {(tier.bundleItems ?? []).map((item, ii) => {
                        const itemUnit = tierUnitPrice(item.price, tier);
                        return (
                          <div key={ii} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span
                              style={{
                                fontSize: "1.2em",
                                fontWeight: 700,
                                color: theme.subtitleColor,
                              }}
                            >
                              +
                            </span>
                            {mainCard(
                              item.quantity > 1
                                ? `${item.title} × ${item.quantity}`
                                : item.title,
                              item.imageUrl,
                              itemUnit * item.quantity,
                              item.price * item.quantity,
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
              {hasGifts && (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                    background: theme.giftBgColor,
                    border: `2px solid ${accented ? theme.accentColor : theme.borderColor}`,
                    borderTop: "none",
                    borderRadius: `0 0 ${theme.tierRadius}px ${theme.tierRadius}px`,
                    padding: "10px 12px",
                  }}
                >
                  {(tier.gifts ?? []).map((gift, gi) => {
                    const units = isBxgy
                      ? tier.quantity + (tier.getQuantity ?? 0)
                      : tier.quantity;
                    const giftQty =
                      (gift.quantity ?? 1) * (gift.perUnit ? units : 1);
                    return (
                    <div
                      key={gi}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        fontSize: "0.86em",
                      }}
                    >
                      {gift.imageUrl && (
                        <img
                          src={gift.imageUrl}
                          alt=""
                          width={24}
                          height={24}
                          style={{
                            borderRadius: 5,
                            objectFit: "cover",
                            border: `1px solid ${theme.borderColor}`,
                          }}
                        />
                      )}
                      <span
                        style={{ fontWeight: 600, color: theme.giftLabelColor }}
                      >
                        + FREE {giftQty > 1 ? `${giftQty}× ` : ""}
                        {gift.title}
                      </span>
                      <span
                        style={{
                          marginLeft: "auto",
                          display: "flex",
                          gap: 6,
                          alignItems: "center",
                        }}
                      >
                        {gift.price > 0 && (
                          <span
                            style={{
                              color: theme.giftPriceColor,
                              textDecoration: "line-through",
                            }}
                          >
                            ${(gift.price * giftQty).toFixed(2)}
                          </span>
                        )}
                        <span
                          style={{
                            color: theme.giftLabelColor,
                            fontWeight: 700,
                          }}
                        >
                          $0.00
                        </span>
                      </span>
                    </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// A color swatch + hex input pair. The native color input gives a picker; the
// text field lets merchants paste an exact hex value.
function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <Text as="span" variant="bodyMd">
        {label}
      </Text>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginTop: 4,
          border: "1px solid #8a8a8a",
          borderRadius: 8,
          padding: "4px 8px",
        }}
      >
        <input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-label={`${label} color`}
          style={{
            width: 28,
            height: 28,
            border: "none",
            background: "none",
            padding: 0,
            cursor: "pointer",
          }}
        />
        <input
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-label={`${label} hex`}
          style={{
            border: "none",
            outline: "none",
            width: "100%",
            fontSize: 13,
            fontFamily: "monospace",
          }}
        />
      </div>
    </div>
  );
}

// Format a millisecond duration as MM:SS, HH:MM:SS, or Dd HH:MM:SS.
function formatCountdown(ms: number): string {
  if (ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600) % 24;
  const days = Math.floor(total / 86400);
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  if (days > 0) return `${days}d ${pad(h)}:${pad(m)}:${pad(s)}`;
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    rows.push(items.slice(i, i + size));
  }
  return rows;
}
