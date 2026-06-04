// tests/computeApiUsedPct.test.js
// Tests for the API-driven progress-bar percentage used by app.js's
// renderBrandCards. The function picks the API value when fresh, and
// falls back to the local spend % when the API value is missing or stale.
// See docs/SYSTEM_DESIGN.md §6.3 (Brand Quota flow) and docs/REVIEWS.md R5.

import { describe, it, expect } from 'vitest';

// Mirror of computeApiUsedPct in app.js. Returns a number in [0, 100],
// or null when neither API nor local data is usable.
function computeApiUsedPct(brandKey, state) {
  const api = state.brandQuotas && state.brandQuotas[brandKey];
  const hasFreshApi = api
    && api.fetchedAt
    && (Date.now() - api.fetchedAt) < (state.ROLLING_RESET_STALE_MS || 3_600_000);

  if (hasFreshApi) {
    if (api.unit === 'percent') {
      // remaining/limit × 100 → used%
      return Math.max(0, Math.min(100, 100 - api.remaining));
    }
    if (api.unit === 'requests') {
      const used = (api.limit_value || 0) - (api.remaining || 0);
      if (!api.limit_value) return null;
      return Math.max(0, Math.min(100, (used / api.limit_value) * 100));
    }
  }

  // Local fallback: spent / cap × 100 (capped to [0, 100]).
  const local = state.localUsage && state.localUsage[brandKey];
  if (!local || !local.cap) return null;
  return Math.max(0, Math.min(100, (local.spent / local.cap) * 100));
}

describe('computeApiUsedPct', () => {
  const freshApi = { fetchedAt: Date.now(), unit: 'percent', remaining: 78, limit_value: 100 };
  const staleApi = { fetchedAt: Date.now() - 7_200_000, unit: 'percent', remaining: 50 };

  it('returns API used % for percent-unit brand (recent fetch)', () => {
    const pct = computeApiUsedPct('claude', {
      brandQuotas: { claude: freshApi },
      ROLLING_RESET_STALE_MS: 3_600_000,
    });
    expect(pct).toBe(22); // 100 - 78
  });

  it('returns API used % for requests-unit brand', () => {
    const pct = computeApiUsedPct('claude', {
      brandQuotas: {
        claude: { fetchedAt: Date.now(), unit: 'requests', remaining: 30, limit_value: 100 },
      },
    });
    expect(pct).toBe(70); // (100-30)/100
  });

  it('falls back to local when API fetch is stale', () => {
    const pct = computeApiUsedPct('claude', {
      brandQuotas: { claude: staleApi },
      localUsage: { claude: { spent: 50, cap: 200 } },
    });
    expect(pct).toBe(25); // 50/200
  });

  it('returns null when neither API nor local data exists', () => {
    expect(computeApiUsedPct('claude', {})).toBeNull();
    expect(computeApiUsedPct('claude', { brandQuotas: {}, localUsage: {} })).toBeNull();
  });

  it('clamps to [0, 100]', () => {
    // API reports remaining=120 (impossible, but defensive).
    const pct = computeApiUsedPct('claude', {
      brandQuotas: {
        claude: { fetchedAt: Date.now(), unit: 'percent', remaining: 120 },
      },
    });
    expect(pct).toBe(0);
  });
});
