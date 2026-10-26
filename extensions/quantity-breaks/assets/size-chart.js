(function () {
  // Each size chart block renders a trigger plus a modal root. The root is
  // moved to <body> so no theme ancestor (transform, overflow, z-index) can
  // clip or bury the fixed-position modal.

  function setUnit(root, unit) {
    root.querySelectorAll("[data-sc-unit]").forEach(function (tab) {
      var on = tab.getAttribute("data-sc-unit") === unit;
      tab.classList.toggle("is-active", on);
      tab.setAttribute("aria-selected", on ? "true" : "false");
    });
    root.querySelectorAll("[data-sc-panel]").forEach(function (panel) {
      panel.hidden = panel.getAttribute("data-sc-panel") !== unit;
    });
  }

  function initBlock(block) {
    if (block.dataset.scInit === "1") return;
    block.dataset.scInit = "1";

    var id = block.getAttribute("data-sc-id");
    var root = block.querySelector("[data-sc-root]");
    var opener = block.querySelector("[data-sc-open]");
    if (!root || !opener) return;

    // Theme editor re-renders leave the previous copy behind in <body>.
    document
      .querySelectorAll('body > [data-sc-root][data-sc-id="' + id + '"]')
      .forEach(function (stale) {
        stale.parentNode.removeChild(stale);
      });
    document.body.appendChild(root);

    var modal = root.querySelector(".sc-modal");

    function open() {
      root.classList.add("is-open");
      document.body.style.overflow = "hidden";
      modal.focus();
    }

    function close() {
      root.classList.remove("is-open");
      document.body.style.overflow = "";
      opener.focus();
    }

    opener.addEventListener("click", open);

    root.addEventListener("click", function (event) {
      if (event.target.closest("[data-sc-close]")) {
        close();
        return;
      }
      var tab = event.target.closest("[data-sc-unit]");
      if (tab) setUnit(root, tab.getAttribute("data-sc-unit"));
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && root.classList.contains("is-open")) close();
    });
  }

  function initAll() {
    document.querySelectorAll("[data-sc-block]").forEach(initBlock);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAll);
  } else {
    initAll();
  }

  // Theme editor: blocks are added and re-rendered without a page load.
  document.addEventListener("shopify:section:load", initAll);
  document.addEventListener("shopify:block:select", initAll);
})();
