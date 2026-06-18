// lib/pricing-defaults.js
// Default per-Brand metadata — input/output rates, display name, color, and
// rolling-window spend limits. Single source of truth for both the browser
// (consumed via window.PRICING_DEFAULTS after this <script> loads) and
// Node-side modules (consumed via require('./pricing-defaults')).
//
// UMD-style export so the same file works in both environments without a
// bundler. The user can override inputCost/outputCost/limit5h/limitWeekly
// at runtime through the "Customize Rates" modal; the override is stored
// in localStorage.atm_brand_metadata and applies to the client only. The
// server-side RTK aggregator always uses these defaults.
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PRICING_DEFAULTS = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  return {
    gemini:  { name: 'Antigravity', inputCost: 1.25, outputCost: 5.00,  color: 'var(--color-gemini)',  limit5h: 2.00, limitWeekly: 15.00 },
    claude:  { name: 'Claude',      inputCost: 3.00, outputCost: 15.00, color: 'var(--color-claude)',  limit5h: 5.00, limitWeekly: 30.00 },
    minimax: { name: 'Minimax',     inputCost: 1.00, outputCost: 4.00,  color: 'var(--color-minimax)', limit5h: 2.00, limitWeekly: 15.00 },
    glm:     { name: 'GLM',         inputCost: 0.50, outputCost: 2.00,  color: 'var(--color-glm)',     limit5h: 0.80, limitWeekly:  6.00 }
  };
}));
