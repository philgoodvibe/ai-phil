/**
 * AI Phil Embed Loader
 *
 * Usage (any HTML page):
 *   <script src="https://your-host.com/ai-phil-embed.js"
 *           data-context="discovery"
 *           async></script>
 *
 * Data attributes:
 *   data-context   "discovery" | "implementation" | "new-member" | "member"   (default: "member")
 *                  — "discovery", "implementation", "new-member" work on any site (no auth)
 *                  — "member" auto-picks based on the user's auth state (SAGE portal only)
 *   data-position  "bottom-right" | "bottom-left"   (default: "bottom-right")
 *   data-cta-label Label for the floating button   (default: "Talk to AI Phil")
 *   data-mode      "voice" | "chat"   (default: "voice")
 *   data-theme     "dark"   (default; light mode TBD)
 *
 * Programmatic API (after load):
 *   window.AIPhil.open()
 *   window.AIPhil.close()
 *   window.AIPhil.toggle()
 */

(function () {
  "use strict";
  if (window.AIPhil && window.AIPhil._mounted) return; // prevent double-mount

  // Resolve host from the currently executing <script src="...">
  var currentScript = document.currentScript || (function () {
    var all = document.getElementsByTagName("script");
    return all[all.length - 1];
  })();
  var scriptSrc = currentScript && currentScript.src ? currentScript.src : "";
  var host = scriptSrc ? new URL(scriptSrc).origin : window.location.origin;

  var context = (currentScript && currentScript.dataset.context) || "member";
  var position = (currentScript && currentScript.dataset.position) || "bottom-right";
  var ctaLabel = (currentScript && currentScript.dataset.ctaLabel) || "Talk to AI Phil";
  var mode = (currentScript && currentScript.dataset.mode) || "voice";

  var FLOAT_STYLES = {
    "bottom-right": "right: 20px; bottom: 20px;",
    "bottom-left": "left: 20px; bottom: 20px;",
  };

  // Build iframe URL
  var iframeSrc = host + "/embed/ai-phil?context=" + encodeURIComponent(context);
  if (mode === "chat") iframeSrc += "&mode=chat";

  // Create launcher (floating pill)
  var launcher = document.createElement("button");
  launcher.setAttribute("aria-label", ctaLabel);
  launcher.setAttribute("type", "button");
  var avatarSrc = host + "/ai-phil-avatar.jpg";
  launcher.innerHTML =
    '<img src="' + avatarSrc + '" alt="AI Phil" ' +
    'style="width:32px;height:32px;border-radius:50%;object-fit:cover;flex-shrink:0;' +
    'box-shadow:0 0 0 2px rgba(253,208,67,0.6);" />' +
    '<span style="letter-spacing:-0.005em;">' + escapeHtml(ctaLabel) + "</span>";
  launcher.style.cssText =
    "position: fixed; " + FLOAT_STYLES[position] + " z-index: 2147483646; " +
    "display: inline-flex; align-items: center; gap: 10px; padding: 10px 18px 10px 8px; " +
    "background: #0a1928; color: #f5f0e6; " +
    "border: 1px solid rgba(245,240,230,0.08); border-radius: 999px; " +
    "box-shadow: 0 16px 40px -8px rgba(0,0,0,0.45), 0 6px 20px -6px rgba(0,0,0,0.3); " +
    "cursor: pointer; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; " +
    "font-size: 14px; font-weight: 500; " +
    "transition: transform 0.2s ease, box-shadow 0.2s ease;";
  launcher.addEventListener("mouseenter", function () {
    launcher.style.transform = "translateY(-2px) scale(1.02)";
  });
  launcher.addEventListener("mouseleave", function () {
    launcher.style.transform = "translateY(0) scale(1)";
  });

  // Iframe shell
  var iframe = document.createElement("iframe");
  iframe.setAttribute("allow", "microphone; autoplay");
  iframe.setAttribute("title", "AI Phil — voice assistant");
  iframe.style.cssText =
    "position: fixed; " + FLOAT_STYLES[position] + " z-index: 2147483647; " +
    "width: 380px; height: 600px; border: 0; border-radius: 20px; " +
    "box-shadow: 0 24px 60px -12px rgba(0,0,0,0.45), 0 8px 24px -8px rgba(0,0,0,0.3); " +
    "background: #0a1928; " +
    "display: none; " +
    "transform-origin: " + (position === "bottom-left" ? "bottom left" : "bottom right") + ";";

  // State management
  var isOpen = false;

  function open() {
    if (isOpen) return;
    if (!iframe.src) iframe.src = iframeSrc;
    iframe.style.display = "block";
    launcher.style.display = "none";
    isOpen = true;
  }

  function close() {
    if (!isOpen) return;
    iframe.style.display = "none";
    launcher.style.display = "inline-flex";
    isOpen = false;
  }

  function toggle() {
    isOpen ? close() : open();
  }

  launcher.addEventListener("click", toggle);

  // Listen for close signals from the iframe (widget sends postMessage on End)
  window.addEventListener("message", function (e) {
    if (!e.data || typeof e.data !== "object") return;
    if (e.data.type === "ai-phil:close") close();
    if (e.data.type === "ai-phil:open") open();
  });

  // Mount on DOM ready
  function mount() {
    document.body.appendChild(launcher);
    document.body.appendChild(iframe);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }

  // Expose public API
  window.AIPhil = {
    _mounted: true,
    open: open,
    close: close,
    toggle: toggle,
    host: host,
    context: context,
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[c];
    });
  }
})();
