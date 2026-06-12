// lib/brand-detect.js
// Brand detection for RTK original_cmd strings. Returns null for shell
// commands (git, ls, curl to localhost, etc.) so callers can skip them.
// Server-side detectSpecificBrand in lib/rtk-metrics.js falls back to
// 'claude' because RTK only records proxied commands; the client filter
// is stricter to exclude non-LLM entries from the live feed.
// Browser-only — consumed via window.detectBrand after <script> loads.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BrandDetect = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  return {
    detectBrand: function (cmd) {
      if (!cmd || typeof cmd !== 'string') return null;
      var c = cmd.toLowerCase();
      if (c.includes('gemini') || c.includes('google-generative') || c.includes('genai')) return 'gemini';
      if (c.includes('minimax')) return 'minimax';
      if (c.includes('glm') || c.includes('zhipu')) return 'glm';
      if (c.includes('claude') || c.includes('anthropic')) return 'claude';
      return null;
    }
  };
}));
