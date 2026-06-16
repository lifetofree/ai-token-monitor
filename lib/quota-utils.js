// lib/quota-utils.js
// Quota business logic shared between server (lib/firebase.js) and browser (app.js).
// UMD: sets module.exports in Node (Vitest, firebase.js) and window.QuotaUtils in the browser.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.QuotaUtils = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // computeApiUsedPct — canonical bar-fill logic for provider API quota.
  // Returns a number in [0, 100] (used %) or null when the API data can't
  // drive the bar for this scope (e.g. per_minute unit for the 5h scope).
  // Mirrors the bar-priority logic in app.js renderBrandCards().
  function computeApiUsedPct(apiQuota, scope) {
    if (!apiQuota) return null;

    if (scope === '5h') {
      if (apiQuota.unit === 'percent' && typeof apiQuota.remaining === 'number') {
        return Math.max(0, Math.min(100, 100 - apiQuota.remaining));
      }
      // 'per_minute' is a per-minute token bucket, not a 5h window — skip it
      // so the 5h bar always uses RTK rolling spend for such brands.
      if (apiQuota.unit === 'requests'
          && typeof apiQuota.remaining === 'number'
          && typeof apiQuota.limit_value === 'number'
          && apiQuota.limit_value > 0) {
        return Math.max(0, Math.min(100,
          ((apiQuota.limit_value - apiQuota.remaining) / apiQuota.limit_value) * 100));
      }
      return null;
    }

    if (scope === 'weekly') {
      if (typeof apiQuota.weekly_remaining !== 'number') return null;
      // Weekly is always reported as percent by every integrated provider.
      return Math.max(0, Math.min(100, 100 - apiQuota.weekly_remaining));
    }

    return null;
  }

  // calcSpendPct — cost vs dollar budget as a clamped [0, 100] float.
  // Callers that need an integer (e.g. Firebase storage) apply Math.round().
  function calcSpendPct(cost, limit) {
    if (!limit || limit <= 0) return 0;
    return Math.min(100, (cost / limit) * 100);
  }

  // calcForecast — projects when the current 5h spend budget will be exhausted
  // at the observed burn rate. Returns an absolute epoch ms for the depletion
  // point, or null when the projection is unavailable or not useful:
  //   - no requests yet (earliestMs is null)
  //   - zero spend (burn rate is zero)
  //   - budget already over limit
  //   - forecast falls after the reset window (budget resets first — not useful)
  //
  // resetRemainingMs: milliseconds until the window resets (duration, not epoch).
  //   Pass null when unknown — forecast is shown regardless of window boundary.
  function calcForecast(costSpent, limitBudget, earliestMs, resetRemainingMs, now) {
    if (!earliestMs || costSpent <= 0 || limitBudget <= 0) return null;
    const elapsed = now - earliestMs;
    if (elapsed <= 0) return null;
    const remaining = limitBudget - costSpent;
    if (remaining <= 0) return null; // already at or over budget
    const burnRatePerMs = costSpent / elapsed;
    const msUntilExhaustion = remaining / burnRatePerMs;
    // Suppress when budget resets before exhaustion — not actionable.
    if (resetRemainingMs != null && msUntilExhaustion > resetRemainingMs) return null;
    return now + msUntilExhaustion;
  }

  return { computeApiUsedPct, calcSpendPct, calcForecast };
}));
