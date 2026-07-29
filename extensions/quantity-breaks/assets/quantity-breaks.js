(function () {

  // Hide the theme's native variant selector, theme-agnostically: Shopify
  // option controls share standard signals across theme generations — inputs
  // named `options[...]`, `.single-option-selector` (vintage), and the OS 2.0
  // <variant-selects>/<variant-radios> custom elements. We hide each control's
  // nearest sensible wrapper. Runs only when the merchant enabled the setting.
  function hideThemeVariantPicker() {
    var controls = document.querySelectorAll(
      '[name^="options["], [name="id"] ~ .single-option-selector,' +
        " .single-option-selector, variant-selects, variant-radios," +
        " [data-option-index], .product-form__input--pill," +
        " .product-form__input--dropdown, .product-form__input--swatch",
    );
    Array.prototype.forEach.call(controls, function (el) {
      // <variant-selects>/<variant-radios> are the picker themselves; other
      // controls sit inside a labelled wrapper we want to remove whole.
      var tag = el.tagName.toLowerCase();
      var wrap =
        tag === "variant-selects" || tag === "variant-radios"
          ? el
          : el.closest(
              "fieldset, .product-form__input, .selector-wrapper," +
                " .variant-input-wrap, .product-form__variants," +
                " .product-options, .product-option, [data-product-option]",
            ) || el;
      wrap.style.setProperty("display", "none", "important");
    });
  }

  // --- Add to cart -------------------------------------------------------
  // The widget owns no button. Instead it rewrites the theme's Add to cart form
  // to carry the selected tier's line items, then lets the theme submit and
  // handle the cart exactly as it does for a normal add.

  function findProductForm() {
    // The REAL add-to-cart form is the one containing the Add button. Other
    // forms also post to /cart/add — notably the Shop Pay installments form
    // (id/class contains "installment") which has no Add button — so prefer the
    // form that owns an [name="add"] control.
    var addBtn = document.querySelector(
      'form[action*="/cart/add"] [name="add"], product-form [name="add"]',
    );
    if (addBtn && addBtn.closest("form")) return addBtn.closest("form");

    var forms = Array.prototype.slice.call(
      document.querySelectorAll('form[action*="/cart/add"]'),
    );
    var real = forms.filter(function (f) {
      return !/installment/i.test((f.id || "") + " " + (f.className || ""));
    });
    if (real.length) return real[0];

    var pf = document.querySelector("product-form form");
    return pf || forms[0] || null;
  }

  function cartRoot() {
    return (
      (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) ||
      "/"
    );
  }

  // Quietly put line items in the cart without touching the UI at all. Used for
  // every line except the last one — see bindAddGuard.
  function preAddItems(items) {
    return fetch(cartRoot() + "cart/add.js", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: items }),
    }).then(function (res) {
      if (!res.ok) throw new Error("pre-add failed " + res.status);
      return res.json();
    });
  }

  // Point the theme's own form fields at a single line item.
  function setFormVariant(form, item) {
    var idInput = form.querySelector('[name="id"]');
    if (idInput) idInput.value = String(item.id);

    var qtyInput = form.querySelector('[name="quantity"]');
    if (qtyInput) {
      qtyInput.value = String(item.quantity);
      // Quantity widgets (<quantity-input>) mirror this into their own state.
      qtyInput.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  // Drive the theme's Add to cart.
  //
  // Themes render their drawer from the add.js response, and most of them (Dawn
  // included) can only parse a SINGLE-item response — a multi-item `items:[]`
  // add returns a shape without the `id` field their render code expects, so it
  // throws and the drawer never updates. That is why doing the whole add
  // ourselves left the cart stale until a refresh.
  //
  // So we split the work: every line except the last is added quietly in the
  // background, then the theme performs a completely ordinary single-item add
  // for the final line. The theme's own code opens and renders the drawer, and
  // because it re-reads the cart from the server that render includes the lines
  // we pre-added. We never touch the drawer's markup, so its CSS is untouched.
  function bindAddGuard(getItems) {
    var form = findProductForm();
    if (!form || form.__qbGuard) return;
    form.__qbGuard = true;

    var replaying = false;

    function handler(e) {
      // Our own replayed add — step aside and let the theme handle it. This
      // must stay true for BOTH the click and the submit it triggers, or we'd
      // re-enter and pre-add the extra lines a second time.
      if (replaying) return;

      var items = getItems();
      if (!items || !items.length) return; // nothing selected → theme handles it

      // Hand the MAIN product line to the theme (it's first in the list) and
      // pre-add the rest. Themes that show an "added to cart" notification name
      // the item they added, so it should be the product, not a free gift.
      //
      // The theme always adds exactly ONE unit: its quantity field is owned by
      // its own quantity widget, which re-syncs from its internal state as it
      // submits and discards whatever we wrote. So any units beyond the first
      // go through the pre-add instead. Shopify merges them into a single cart
      // line, since it's the same variant.
      var first = items[0];
      var main = { id: first.id, quantity: 1 };
      var extras = items.slice(1);
      if (first.quantity > 1) {
        extras.unshift({ id: first.id, quantity: first.quantity - 1 });
      }

      // Exactly one unit in total: nothing to pre-add, so let the theme submit
      // this very event. Fully native, nothing intercepted.
      if (!extras.length) {
        setFormVariant(form, main);
        return;
      }

      // Multiple lines: hold this submit, seed the extras, then replay it.
      e.preventDefault();
      e.stopImmediatePropagation();

      preAddItems(extras)
        .catch(function (err) {
          if (window.console && console.error) {
            console.error("[quantity-breaks] pre-add failed:", err);
          }
        })
        .then(function () {
          setFormVariant(form, main);
          replaying = true;
          try {
            submitViaTheme(form);
          } finally {
            // The theme's click/submit handlers run synchronously above, so the
            // flag has done its job by the next tick.
            setTimeout(function () {
              replaying = false;
            }, 0);
          }
        });
    }

    form.addEventListener("submit", handler, true);
    Array.prototype.forEach.call(
      form.querySelectorAll('[type="submit"], [name="add"]'),
      function (btn) {
        btn.addEventListener("click", handler, true);
      },
    );
  }

  // Re-trigger the theme's add-to-cart the same way a shopper would, so its own
  // handler runs (and with it, its drawer open + render).
  function submitViaTheme(form) {
    var btn = form.querySelector('[name="add"], [type="submit"]');
    if (btn) {
      btn.click();
      return;
    }
    if (typeof form.requestSubmit === "function") {
      form.requestSubmit();
    } else {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    }
  }

  function parseVariants(widget) {
    var el = widget.querySelector("[data-qb-variants]");
    if (!el) return [];
    try {
      return JSON.parse(el.textContent) || [];
    } catch (e) {
      return [];
    }
  }

  // Resolve the variant id chosen for a given item (#unit) in a tier panel,
  // by matching its selected option values against the variant list.
  function variantIdForUnit(panel, unit, variants) {
    if (!panel || !variants.length) return null;
    var selected = [];
    var holders = panel.querySelectorAll(
      '[data-qb-unit="' + unit + '"][data-qb-option-position]',
    );
    Array.prototype.forEach.call(holders, function (h) {
      var pos = parseInt(h.getAttribute("data-qb-option-position"), 10);
      if (!pos) return;
      var val = null;
      if (h.tagName === "SELECT") {
        val = h.value;
      } else {
        var sel = h.querySelector(".qb-swatch--selected");
        val = sel ? sel.getAttribute("data-qb-value") : null;
      }
      selected[pos - 1] = val;
    });
    for (var i = 0; i < variants.length; i++) {
      var v = variants[i];
      if (!v.options || v.options.length !== selected.length) continue;
      var match = true;
      for (var j = 0; j < selected.length; j++) {
        if (selected[j] != null && v.options[j] !== selected[j]) {
          match = false;
          break;
        }
      }
      if (match) return v.id;
    }
    return null;
  }

  // Color/button variant swatches (the dropdown picker type is a native
  // <select> and needs no JS). Each [data-qb-swatch-group] is single-select:
  // clicking a swatch selects it within its group, then runs `onChange`.
  function initSwatches(widget, onChange) {
    var groups = Array.prototype.slice.call(
      widget.querySelectorAll("[data-qb-swatch-group]"),
    );
    groups.forEach(function (group) {
      var swatches = Array.prototype.slice.call(
        group.querySelectorAll("[data-qb-swatch]"),
      );
      swatches.forEach(function (btn) {
        if (btn.classList.contains("qb-swatch--soldout")) return;
        btn.addEventListener("click", function () {
          swatches.forEach(function (b) {
            var on = b === btn;
            b.classList.toggle("qb-swatch--selected", on);
            b.setAttribute("aria-pressed", on ? "true" : "false");
          });
          if (typeof onChange === "function") onChange();
        });
      });
    });
  }

  // Live countdown timer. Supports a fixed evergreen duration (persisted per
  // visitor in localStorage), end-of-day in the visitor's local time, or a
  // fixed end date. The title's {{timer}} placeholder is replaced each second.
  function initCountdown(widget) {
    var el = widget.querySelector("[data-qb-countdown]");
    if (!el) return;

    var mode = el.getAttribute("data-qb-mode") || "FIXED";
    var minutes = parseInt(el.getAttribute("data-qb-minutes"), 10) || 15;
    var endAttr = el.getAttribute("data-qb-end") || "";
    var title = el.getAttribute("data-qb-title") || "";
    var storageKey =
      "qb_countdown_" +
      (widget.getAttribute("data-variant-id") || "qb") +
      "_" +
      minutes;

    function targetTime() {
      if (mode === "DATE" && endAttr) {
        var t = new Date(endAttr).getTime();
        return isNaN(t) ? null : t;
      }
      if (mode === "MIDNIGHT") {
        var d = new Date();
        d.setHours(24, 0, 0, 0); // next local midnight
        return d.getTime();
      }
      // FIXED: evergreen — persist an end time per visitor.
      var stored = 0;
      try {
        stored = parseInt(localStorage.getItem(storageKey) || "0", 10);
      } catch (e) {
        /* ignore */
      }
      var now = Date.now();
      if (!stored || stored < now) {
        stored = now + minutes * 60000;
        try {
          localStorage.setItem(storageKey, String(stored));
        } catch (e) {
          /* ignore */
        }
      }
      return stored;
    }

    var target = targetTime();

    function pad(n) {
      return n < 10 ? "0" + n : "" + n;
    }
    function fmt(ms) {
      if (ms < 0) ms = 0;
      var total = Math.floor(ms / 1000);
      var s = total % 60;
      var m = Math.floor(total / 60) % 60;
      var h = Math.floor(total / 3600) % 24;
      var days = Math.floor(total / 86400);
      if (days > 0) return days + "d " + pad(h) + ":" + pad(m) + ":" + pad(s);
      if (h > 0) return pad(h) + ":" + pad(m) + ":" + pad(s);
      return pad(m) + ":" + pad(s);
    }

    function render() {
      if (target == null) {
        el.textContent = title.replace(/\{\{\s*timer\s*\}\}/g, "");
        return;
      }
      var remaining = target - Date.now();
      if (remaining <= 0) {
        if (mode === "FIXED") {
          target = Date.now() + minutes * 60000;
          try {
            localStorage.setItem(storageKey, String(target));
          } catch (e) {
            /* ignore */
          }
          remaining = target - Date.now();
        } else {
          remaining = 0;
        }
      }
      el.textContent = title.replace(/\{\{\s*timer\s*\}\}/g, fmt(remaining));
    }

    render();
    setInterval(render, 1000);
  }

  function initWidget(widget) {
    if (widget.dataset.qbInit === "1") return;
    widget.dataset.qbInit = "1";

    // Reveal the widget. It renders hidden by default so that, when the app
    // embed is disabled (and therefore this script never loads), nothing shows.
    widget.style.display = "";

    // Signal currency converter apps to re-scan our newly visible price elements.
    // Different apps listen to different events or expose different APIs.
    setTimeout(function () {
      // Event-based converters (BEST Currency Converter, Auto Currency Switcher, etc.)
      ['currency:updated', 'theme:currency:change', 'shopify:currency:change'].forEach(function (name) {
        document.dispatchEvent(new CustomEvent(name, { bubbles: true }));
      });
      // mlveda / old-style converters expose a global convertAll function
      try {
        if (window.Currency && typeof window.Currency.convertAll === 'function') {
          var from = (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) || 'USD';
          window.Currency.convertAll(window.shopCurrency || from, from);
        }
      } catch (e) { /* ignore */ }
    }, 0);

    var tiers = Array.prototype.slice.call(
      widget.querySelectorAll("[data-qb-tier]"),
    );

    var variants = parseVariants(widget);

    // Free gifts for the selected tier: every gift on that tier and on any
    // lower tier (granted "at/above" its quantity), keyed by variant with the
    // highest granted quantity.
    function giftItems(selectedLabel) {
      var selQty = parseInt(selectedLabel.getAttribute("data-qty"), 10) || 0;
      var byId = {};
      tiers.forEach(function (t) {
        var tq = parseInt(t.getAttribute("data-qty"), 10) || 0;
        if (tq > selQty) return;
        (t.getAttribute("data-qb-gifts") || "").split(",").forEach(function (
          pair,
        ) {
          pair = pair.trim();
          if (!pair) return;
          var parts = pair.split(":");
          var id = parts[0];
          var qty = parseInt(parts[1], 10) || 1;
          if (!id) return;
          byId[id] = Math.max(byId[id] || 0, qty);
        });
      });
      return Object.keys(byId).map(function (id) {
        return { id: Number(id), quantity: byId[id] };
      });
    }

    // "Complete the bundle" items on the selected tier only (unlike gifts,
    // these aren't granted "at/above" — a bundle is a specific break).
    function bundleItemsFor(selectedLabel) {
      var items = [];
      (selectedLabel.getAttribute("data-qb-bundle-items") || "")
        .split(",")
        .forEach(function (pair) {
          pair = pair.trim();
          if (!pair) return;
          var parts = pair.split(":");
          var id = parts[0];
          var qty = parseInt(parts[1], 10) || 1;
          if (!id) return;
          items.push({ id: Number(id), quantity: qty });
        });
      return items;
    }

    // The line items to add for the current selection (main product + gifts).
    //  • Per-item pickers on  → one line per item, using each item's chosen
    //    variant (identical variants are merged into one line with a count).
    //  • Pickers off           → a single line of the theme's current variant.
    function getItems() {
      var label = null;
      tiers.forEach(function (t) {
        if (t.classList.contains("qb-tier--selected")) label = t;
      });
      if (!label) return null;
      var radio = label.querySelector(".qb-radio");
      var qty = radio ? parseInt(radio.value, 10) || 1 : 1;

      var fallbackId = widget.getAttribute("data-variant-id");
      var wrap = label.closest(".qb-tier-wrap");
      var panel = wrap && wrap.querySelector("[data-qb-tier-variants]");

      var items = null;
      if (panel && variants.length) {
        // Resolve a variant per item, then merge identical ones.
        var counts = {};
        for (var u = 1; u <= qty; u++) {
          var vid = variantIdForUnit(panel, u, variants) || fallbackId;
          if (!vid) continue;
          counts[vid] = (counts[vid] || 0) + 1;
        }
        var picked = Object.keys(counts).map(function (id) {
          return { id: Number(id), quantity: counts[id] };
        });
        if (picked.length) items = picked;
      }

      if (!items) {
        // No per-item pickers: single line of the theme's current variant.
        var form = findProductForm();
        var idInput = form && form.querySelector('[name="id"]');
        var variantId = (idInput && idInput.value) || fallbackId;
        if (!variantId) return null;
        items = [{ id: Number(variantId), quantity: qty }];
      }

      return items.concat(bundleItemsFor(label)).concat(giftItems(label));
    }

    function select(tier) {
      tiers.forEach(function (t) {
        var isTarget = t === tier;
        t.classList.toggle("qb-tier--selected", isTarget);
        var radio = t.querySelector(".qb-radio");
        if (radio) radio.checked = isTarget;

        // Show only the selected tier's per-unit variant pickers.
        var wrap = t.closest(".qb-tier-wrap");
        if (wrap) {
          wrap.classList.toggle("qb-tier-wrap--selected", isTarget);
          var panel = wrap.querySelector("[data-qb-tier-variants]");
          if (panel) panel.hidden = !isTarget;
        }
      });
    }

    tiers.forEach(function (tier) {
      tier.addEventListener("click", function () {
        select(tier);
      });
    });

    initSwatches(widget);
    initCountdown(widget);
    bindAddGuard(getItems);
  }

  function initAll() {
    // Marks the app as active. Theme-element overrides (hiding the native
    // variant picker) are scoped to this class, so they only apply when the app
    // embed is enabled — otherwise the theme is untouched.
    document.documentElement.classList.add("qb-app-enabled");
    document.querySelectorAll("[data-qb-widget]").forEach(initWidget);
    if (document.querySelector("[data-qb-hide-theme-variants]")) {
      hideThemeVariantPicker();
      // Themes that re-render the product form (variant swaps) can restore it;
      // re-hide shortly after and on the next frame to cover late renders.
      setTimeout(hideThemeVariantPicker, 300);
      setTimeout(hideThemeVariantPicker, 1200);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAll);
  } else {
    initAll();
  }
})();
