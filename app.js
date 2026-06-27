// AI Token Monitor Application JavaScript

// 1. CONSTANTS & METADATA

// escapeHtml delegated to lib/dom-utils.js (window.DomUtils.escapeHtml)
function escapeHtml(str) { return DomUtils.escapeHtml(str); }

// Brand color source of truth lives in styles.css. Read from CSS custom properties
// so light/dark themes and any palette tweak flow through to JS automatically.
function getBrandColor(key) {
  if (typeof window === 'undefined') return '#94a3b8';
  const val = getComputedStyle(document.documentElement).getPropertyValue(`--color-${key}`).trim();
  return val || '#94a3b8';
}

const FALLBACK_BRAND_COLOR = '#94a3b8';

// PRICING_DEFAULTS is loaded from lib/pricing-defaults.js (must be included
// BEFORE app.js in index.html). Single source of truth shared with the
// server-side RTK aggregator at lib/rtk-metrics.js. The inline fallback
// below is only reached if the UMD module failed to load (e.g. the static
// handler returned 404 for the new path before the dev server was
// restarted). It must be kept in sync with lib/pricing-defaults.js.
const DEFAULT_BRAND_METADATA = window.PRICING_DEFAULTS || {
  gemini:  { name: 'Antigravity', inputCost: 1.25, outputCost: 5.00,  color: 'var(--color-gemini)',  limit5h: 2.00, limitWeekly: 15.00 },
  claude:  { name: 'Claude',      inputCost: 3.00, outputCost: 15.00, color: 'var(--color-claude)',  limit5h: 5.00, limitWeekly: 30.00 },
  minimax: { name: 'Minimax',     inputCost: 1.00, outputCost: 4.00,  color: 'var(--color-minimax)', limit5h: 2.00, limitWeekly: 15.00 },
  glm:     { name: 'GLM',         inputCost: 0.50, outputCost: 2.00,  color: 'var(--color-glm)',     limit5h: 0.80, limitWeekly:  6.00 }
};
if (!window.PRICING_DEFAULTS) {
  console.warn('[ai-token-monitor] lib/pricing-defaults.js did not load; using inline fallback. Restart the dev server to pick up the UMD module.');
}

// State variables
let state = {
  brandMetadata: JSON.parse(localStorage.getItem('atm_brand_metadata')) || JSON.parse(JSON.stringify(DEFAULT_BRAND_METADATA)),
  requests: JSON.parse(localStorage.getItem('atm_requests')) || [],
  realCommands: [],
  monitorMode: 'real',
  isAutoSimulating: localStorage.getItem('atm_auto_sim') !== 'false',
  theme: localStorage.getItem('atm_theme') || 'light',
  currentSort: { key: 'brand', direction: 'asc' },
  agentUsage: null
};

// Migration: Ensure new brands and fields exist in loaded state (older localStorage payloads)
Object.keys(DEFAULT_BRAND_METADATA).forEach(bKey => {
  if (!state.brandMetadata[bKey]) {
    // New brand added since last save — inject it with defaults
    state.brandMetadata[bKey] = JSON.parse(JSON.stringify(DEFAULT_BRAND_METADATA[bKey]));
  } else {
    const def = DEFAULT_BRAND_METADATA[bKey];
    Object.keys(def).forEach(field => {
      if (state.brandMetadata[bKey][field] === undefined) {
        state.brandMetadata[bKey][field] = def[field];
      }
    });
  }
});

// Clean up any keys that are no longer in DEFAULT_BRAND_METADATA (e.g., deprecated rtk brand)
Object.keys(state.brandMetadata).forEach(bKey => {
  if (!DEFAULT_BRAND_METADATA[bKey]) {
    delete state.brandMetadata[bKey];
  }
});

// Migration: If the name is "Gemini", rename it to "Antigravity"
if (state.brandMetadata.gemini && state.brandMetadata.gemini.name === 'Gemini') {
  state.brandMetadata.gemini.name = 'Antigravity';
  localStorage.setItem('atm_brand_metadata', JSON.stringify(state.brandMetadata));
}


// UI Config — single source of truth for tunable constants
const REFRESH_INTERVAL_SECONDS = 30;
const MAX_REQUESTS_RETAINED = 500;       // Cap for both sim + real modes (was inconsistent: 500 vs 200)
const MAX_CONSOLE_LINES = 200;           // DOM prune threshold
const SIM_DELAY_MIN_MS = 8000;
const SIM_DELAY_MAX_MS = 20000;
const SIM_HISTORY_PRELOAD = 40;          // Pre-populated mock requests on first sim run
const FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000;
const ONE_WEEK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ROLLING_LIMIT_WARN_PCT = 70;
const ROLLING_LIMIT_DANGER_PCT = 90;
const NOTIF_DEBOUNCE_MS = 30 * 60 * 1000; // 30 min per brand
const _notifDebounce = new Map(); // brand → last notification timestamp

let refreshTimer = REFRESH_INTERVAL_SECONDS;
let refreshTimerIntervalId = null;
let simulationTimeoutId = null;

/// DOM Elements — populated in init() to guarantee the DOM is ready.
let elements = {};

// 2. INITIALIZATION
function initElements() {
  elements = {
    themeToggleBtn: document.getElementById('theme-toggle-btn'),
    themeIcon: document.getElementById('theme-icon'),

    // Timer Elements
    timerProgressRing: document.getElementById('timer-progress-ring'),
    timerText: document.getElementById('timer-text'),
    lastUpdatedText: document.getElementById('last-updated-text'),

    // Global stat values
    valTotalRequests: document.getElementById('val-total-requests'),
    valTotalTokens: document.getElementById('val-total-tokens'),
    valInputTokens: document.getElementById('val-input-tokens'),
    valOutputTokens: document.getElementById('val-output-tokens'),
    valTotalCost: document.getElementById('val-total-cost'),
    valTotalSavings: document.getElementById('val-total-savings'),
    valSavedTokens: document.getElementById('val-saved-tokens'),
    valSavingsPercentage: document.getElementById('val-savings-percentage'),

    // Section containers
    brandCardsContainer: document.getElementById('brand-cards-container'),
    tableBody: document.getElementById('table-body'),
    consoleLogsStream: document.getElementById('console-logs-stream'),
    simActivityDot: document.getElementById('sim-activity-dot'),
    consoleStatusIndicator: document.getElementById('console-status-indicator'),
    valSimulationSpeed: document.getElementById('val-simulation-speed'),

    // Control buttons
    openSettingsModalBtn: document.getElementById('open-settings-modal-btn'),
    clearLogsBtn: document.getElementById('clear-logs-btn'),
    exportCsvBtn: document.getElementById('export-csv-btn'),

    // Modals
    settingsModal: document.getElementById('settings-modal'),
    pricingRatesForm: document.getElementById('pricing-rates-form'),
    pricingRatesFormFields: document.getElementById('pricing-rates-form-fields'),

    // Settings Tabs & Tokens
    tabRatesBtn: document.getElementById('tab-rates-btn'),
    tabTokensBtn: document.getElementById('tab-tokens-btn'),
    tabContentRates: document.getElementById('tab-content-rates'),
    tabContentTokens: document.getElementById('tab-content-tokens'),
    tokenAnthropic: document.getElementById('token-anthropic'),
    tokenGemini: document.getElementById('token-gemini'),
    tokenGlm: document.getElementById('token-glm'),
    tokenMinimax: document.getElementById('token-minimax'),
    projectsSection: document.getElementById('projects-section'),
    projectsTableContainer: document.getElementById('projects-table-container')
  };
}

function init() {
  // Populate DOM element references now that DOM is guaranteed ready
  initElements();

  // Apply initial theme
  document.documentElement.setAttribute('data-theme', state.theme);
  if (elements.themeIcon) elements.themeIcon.textContent = state.theme === 'dark' ? '☀️' : '🌙';
  const footerYear = document.getElementById('footer-year');
  if (footerYear) footerYear.textContent = new Date().getFullYear();

  // Build pricing rates input fields in settings modal
  buildSettingsFormFields();

  // Bind Event Listeners
  setupEventListeners();

  // Setup tabs layout inside monitor modal
  setupTabs();

  // Fetch API Keys/tokens from .env
  fetchAPIKeys();
  fetchBrandQuotas();
  fetchAgentUsage();
  fetchProjectData();

  // Start countdown loops
  startCountdownTimer();

  if (elements.simActivityDot) elements.simActivityDot.className = 'status-indicator';
  if (elements.valSimulationSpeed) elements.valSimulationSpeed.textContent = 'Monitoring RTK database';
  state.isAutoSimulating = false;
  fetchRealRTKData(true);
  connectRTKStream();
  stampLastUpdated();
  requestNotificationPermission();
}

function requestNotificationPermission() {
  if (!('Notification' in window) || Notification.permission !== 'default') return;
  Notification.requestPermission();
}

function maybeFireQuotaNotification(bKey, pct) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (pct < ROLLING_LIMIT_DANGER_PCT) return;
  const now = Date.now();
  if (now - (_notifDebounce.get(bKey) || 0) < NOTIF_DEBOUNCE_MS) return;
  _notifDebounce.set(bKey, now);
  const meta = state.brandMetadata[bKey];
  const name = meta ? meta.name : bKey;
  new Notification(`${name} quota at ${pct.toFixed(0)}%`, {
    body: `${name} has reached ${pct.toFixed(0)}% of its spending limit.`,
    tag: `quota-${bKey}`
  });
}

// 3. STATS LOGIC (Calculations & UI Rendering)

function calculateAndRenderDashboard() {
  const brandData = {};
  const now = Date.now();
  const fiveHoursAgo = now - FIVE_HOUR_WINDOW_MS;
  const oneWeekAgo = now - ONE_WEEK_WINDOW_MS;

  // Initialize brand accumulator
  Object.keys(state.brandMetadata).forEach(bKey => {
    brandData[bKey] = {
      key: bKey,
      name: state.brandMetadata[bKey].name,
      color: getBrandColor(bKey),
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      savedTokens: 0,
      cost: 0,
      cost5h: 0,
      costWeekly: 0,
      tokens5h: 0,
      tokensWeekly: 0,
      savings: 0,
      earliest5hTimestamp: null,
      earliestWeeklyTimestamp: null
    };
  });

  let globalRequests = 0;
  let globalInputTokens = 0;
  let globalOutputTokens = 0;
  let globalSavedTokens = 0;
  let globalCost = 0;
  let globalSavings = 0;

  // Process request history
  getActiveRequests().forEach(req => {
    const brand = brandData[req.brand];
    if (brand) {
      brand.requests++;
      brand.inputTokens += req.inputTokens;
      brand.outputTokens += req.outputTokens;
      brand.savedTokens += req.savedTokens;
      brand.cost += req.cost;
      brand.savings += req.savings;

      // Calculate temporal rolling totals
      const reqTime = req.timestamp;
      if (reqTime >= fiveHoursAgo) {
        brand.cost5h += req.cost;
        brand.tokens5h += req.inputTokens + req.outputTokens;
        if (brand.earliest5hTimestamp === null || reqTime < brand.earliest5hTimestamp) {
          brand.earliest5hTimestamp = reqTime;
        }
      }
      if (reqTime >= oneWeekAgo) {
        brand.costWeekly += req.cost;
        brand.tokensWeekly += req.inputTokens + req.outputTokens;
        if (brand.earliestWeeklyTimestamp === null || reqTime < brand.earliestWeeklyTimestamp) {
          brand.earliestWeeklyTimestamp = reqTime;
        }
      }

      globalRequests++;
      globalInputTokens += req.inputTokens;
      globalOutputTokens += req.outputTokens;
      globalSavedTokens += req.savedTokens;
      globalCost += req.cost;
      globalSavings += req.savings;
    }
  });

  // Inject agent usage into Gemini brand data if available
  if (state.agentUsage && brandData.gemini) {
    brandData.gemini.inputTokens += state.agentUsage.total.inputTokens;
    brandData.gemini.outputTokens += state.agentUsage.total.outputTokens;
    brandData.gemini.cost += state.agentUsage.total.totalCost;
    brandData.gemini.cost5h += state.agentUsage.window5h.totalCost;
    brandData.gemini.costWeekly += state.agentUsage.weekly.totalCost;
    brandData.gemini.tokens5h += state.agentUsage.window5h.inputTokens + state.agentUsage.window5h.outputTokens;
    brandData.gemini.tokensWeekly += state.agentUsage.weekly.inputTokens + state.agentUsage.weekly.outputTokens;
    brandData.gemini.requests += state.agentUsage.total.conversationsCount;

    if (state.agentUsage.window5h.earliestTimestamp) {
      const agentEarliest5h = state.agentUsage.window5h.earliestTimestamp;
      if (brandData.gemini.earliest5hTimestamp === null || agentEarliest5h < brandData.gemini.earliest5hTimestamp) {
        brandData.gemini.earliest5hTimestamp = agentEarliest5h;
      }
    }
    if (state.agentUsage.weekly.earliestTimestamp) {
      const agentEarliestWeekly = state.agentUsage.weekly.earliestTimestamp;
      if (brandData.gemini.earliestWeeklyTimestamp === null || agentEarliestWeekly < brandData.gemini.earliestWeeklyTimestamp) {
        brandData.gemini.earliestWeeklyTimestamp = agentEarliestWeekly;
      }
    }
  }

  // Render Global stats values
  elements.valTotalRequests.textContent = formatNumber(globalRequests);
  elements.valTotalTokens.textContent = formatNumber(globalInputTokens + globalOutputTokens);
  elements.valInputTokens.textContent = formatCompactNumber(globalInputTokens);
  elements.valOutputTokens.textContent = formatCompactNumber(globalOutputTokens);
  elements.valTotalCost.textContent = formatCurrency(globalCost);
  elements.valTotalSavings.textContent = formatCurrency(globalSavings);
  elements.valSavedTokens.textContent = formatCompactNumber(globalSavedTokens);
  
  const totalAttemptedInput = globalInputTokens + globalSavedTokens;
  const cachingRate = totalAttemptedInput > 0 ? (globalSavedTokens / totalAttemptedInput) * 100 : 0;
  elements.valSavingsPercentage.textContent = cachingRate.toFixed(1) + '%';
  
  // Render Individual Brand Cards
  renderBrandCards(brandData);
  
  // Render Table
  renderTable(brandData);
}

function renderBrandCards(brandData) {
  elements.brandCardsContainer.innerHTML = '';
  const now = Date.now();

  Object.keys(brandData).forEach(bKey => {
    const data = brandData[bKey];
    const meta = state.brandMetadata[bKey];
    const limit5h = meta.limit5h > 0 ? meta.limit5h : 2.00;
    const limitWeekly = meta.limitWeekly > 0 ? meta.limitWeekly : 15.00;
    const pct5h = QuotaUtils.calcSpendPct(data.cost5h, limit5h);
    const pctWeekly = QuotaUtils.calcSpendPct(data.costWeekly, limitWeekly);

    const getLimitStyle = (pct) => {
      if (pct >= ROLLING_LIMIT_DANGER_PCT) return { class: ' limit-danger', color: 'var(--danger)' };
      if (pct >= ROLLING_LIMIT_WARN_PCT) return { class: ' limit-warning', color: 'var(--warning)' };
      return { class: '', color: 'var(--text-muted)' };
    };

    // Reset countdown: oldest request in window drops out after window duration.
    // NOTE: with sustained traffic this is a sliding treadmill — the window never
    // fully "resets", the oldest single request expires and the next becomes oldest.
    // When the provider exposes a real quota-reset timestamp via /api/seed-quotas
    // (state.brandQuotas), prefer that — it's the authoritative window boundary.
    const apiQuota = (state.brandQuotas && state.brandQuotas[bKey]) || null;
    // Provider-authoritative reset times (when the API exposes them). Claude
    // ('local' unit) has no provider window, so reset_at is always null there
    // and the RTK rolling-window boundary is used instead.
    const apiReset5hMs = apiQuota && apiQuota.reset_at && apiQuota.reset_at > now
      ? apiQuota.reset_at - now : null;
    const apiResetWeeklyMs = apiQuota && apiQuota.reset_at_weekly && apiQuota.reset_at_weekly > now
      ? apiQuota.reset_at_weekly - now : null;
    // For brands whose API doesn't expose a 5h reset (e.g. GLM), the server
    // tracks window_started_at (when the current 5h window's contents were
    // first observed) and the reset is at most window_started_at + 5h.
    const windowStartedReset5hMs = (apiReset5hMs === null
      && apiQuota && typeof apiQuota.window_started_at === 'number'
      && apiQuota.window_started_at > 0)
      ? (apiQuota.window_started_at + FIVE_HOUR_WINDOW_MS) - now
      : null;

    // Drive the progress bar from the provider's API quota when available.
    // Claude is RTK-only (unit: 'local') — computeApiUsedPct returns null for
    // it, so both bars fall back to RTK cost-based spend.
    const isLocal = apiQuota && apiQuota.unit === 'local';
    const apiUsedPct5h = QuotaUtils.computeApiUsedPct(apiQuota, '5h');
    const apiUsedPctWeekly = QuotaUtils.computeApiUsedPct(apiQuota, 'weekly');

    // RTK spend data: server embeds RTK metrics in raw_json._rtk_spend (GLM)
    // or uses raw_json directly as RTK spend (Claude). Used for cost-based bar
    // percentages and rolling reset times.
    const rtkSpend = (() => {
      if (!apiQuota) return null;
      // Claude (unit: 'local'): raw_json IS the RTK spend object (cost5h, requests5h, etc.)
      if (isLocal && apiQuota.raw_json && typeof apiQuota.raw_json.cost5h === 'number') {
        const s = apiQuota.raw_json;
        return {
          cost5h: s.cost5h || 0,
          costWeekly: s.costWeekly || 0,
          requests5h: s.requests5h || 0,
          requestsWeekly: s.requestsWeekly || 0,
          tokens5h: s.tokens5h || 0,
          tokensWeekly: s.tokensWeekly || 0,
          reset5hAt: s.reset5hAt || null,
          resetWeeklyAt: s.resetWeeklyAt || null,
        };
      }
      // GLM/other: _rtk_spend embedded in raw_json by seedBrandQuotas
      const raw = apiQuota.raw_json;
      if (raw && raw._rtk_spend) {
        const s = raw._rtk_spend;
        return {
          cost5h: s.cost5h || 0,
          costWeekly: s.costWeekly || 0,
          requests5h: s.requests5h || 0,
          requestsWeekly: s.requestsWeekly || 0,
          reset5hAt: s.reset5hAt || (s.earliest5hTimestamp ? s.earliest5hTimestamp + FIVE_HOUR_WINDOW_MS : null),
          resetWeeklyAt: s.resetWeeklyAt || (s.earliestWeeklyTimestamp ? s.earliestWeeklyTimestamp + ONE_WEEK_WINDOW_MS : null),
        };
      }
      return null;
    })();

    const rtkPct5h     = rtkSpend && limit5h > 0     ? QuotaUtils.calcSpendPct(rtkSpend.cost5h,     limit5h)     : null;
    const rtkPctWeekly = rtkSpend && limitWeekly > 0 ? QuotaUtils.calcSpendPct(rtkSpend.costWeekly, limitWeekly) : null;

    const barPct5h     = apiUsedPct5h     !== null ? apiUsedPct5h     : (rtkPct5h     !== null ? rtkPct5h     : pct5h);
    const barPctWeekly = apiUsedPctWeekly !== null ? apiUsedPctWeekly : (rtkPctWeekly !== null ? rtkPctWeekly : pctWeekly);
    maybeFireQuotaNotification(bKey, Math.max(barPct5h, barPctWeekly));
    const style5h = getLimitStyle(barPct5h);
    const styleWeekly = getLimitStyle(barPctWeekly);
    const barSource5h     = apiUsedPct5h     !== null ? 'api' : (rtkPct5h     !== null ? 'rtk' : 'local');
    const barSourceWeekly = apiUsedPctWeekly !== null ? 'api' : (rtkPctWeekly !== null ? 'rtk' : 'local');
    const barSourceTooltip = (src) => src === 'api'
      ? 'Bar driven by provider API quota (used %).'
      : src === 'rtk'
        ? 'Bar driven by RTK database (server-side aggregation).'
        : 'Bar driven by local rolling-window spend in this dashboard.';

    const rolling5hMs = data.earliest5hTimestamp !== null ? (data.earliest5hTimestamp + FIVE_HOUR_WINDOW_MS) - now : null;
    const rollingWeeklyMs = data.earliestWeeklyTimestamp !== null ? (data.earliestWeeklyTimestamp + ONE_WEEK_WINDOW_MS) - now : null;

    const rtkReset5hMs     = rtkSpend && rtkSpend.reset5hAt     && rtkSpend.reset5hAt     > now ? rtkSpend.reset5hAt     - now : null;
    const rtkResetWeeklyMs = rtkSpend && rtkSpend.resetWeeklyAt && rtkSpend.resetWeeklyAt > now ? rtkSpend.resetWeeklyAt - now : null;

    const reset5hMs = apiReset5hMs !== null
      ? apiReset5hMs
      : (windowStartedReset5hMs !== null
        ? windowStartedReset5hMs
        : (rtkReset5hMs !== null ? rtkReset5hMs : rolling5hMs));
    const resetWeeklyMs = apiResetWeeklyMs !== null
      ? apiResetWeeklyMs
      : (rtkResetWeeklyMs !== null ? rtkResetWeeklyMs : rollingWeeklyMs);

    const rollingTooltip = 'Rolling window: the oldest request in this window falls out at the shown time. With sustained traffic the window slides continuously rather than fully resetting.';
    const apiTooltip = 'Reset time from the provider API (authoritative window boundary).';
    const windowStartedTooltip = 'Reset is a 5h countdown from when the server first observed the current 5h window data; the actual reset is when the oldest request in the window drops out.';
    const rtkTooltip = 'Reset time from RTK local DB (rolling window boundary, server-side).';
    const reset5hTooltip = apiReset5hMs !== null
      ? apiTooltip
      : (windowStartedReset5hMs !== null
        ? windowStartedTooltip
        : (rtkReset5hMs !== null ? rtkTooltip : rollingTooltip));
    const resetWeeklyTooltip = apiResetWeeklyMs !== null
      ? apiTooltip
      : (rtkResetWeeklyMs !== null ? rtkTooltip : rollingTooltip);

    const reset5hLabel = reset5hMs !== null ? `Resets at ${new Date(now + reset5hMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} (${formatTimeRemaining(reset5hMs)})` : 'no active usage';
    const resetWeeklyLabel = resetWeeklyMs !== null ? `Resets at ${new Date(now + resetWeeklyMs).toLocaleDateString([], { month: 'short', day: 'numeric' })} ${new Date(now + resetWeeklyMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} (${formatTimeRemaining(resetWeeklyMs)})` : 'no active usage';

    // Amount labels: provider-specific display.
    // - percent unit (MiniMax, GLM): "X% remaining" from API
    // - local unit (Claude): RTK-tracked token count + cost for the window
    // - otherwise: "$X.XX / $Y.YY" cost-based fallback
    const amounts5h = (apiQuota && apiQuota.unit === 'percent' && typeof apiQuota.remaining === 'number')
      ? `${apiQuota.remaining}% remaining`
      : isLocal
        ? `${formatCompactNumber(rtkSpend ? rtkSpend.tokens5h : data.tokens5h)} tokens · ${formatCurrency(rtkSpend ? rtkSpend.cost5h : data.cost5h)}`
        : `${formatCurrency(data.cost5h)} / ${formatCurrency(limit5h)}`;
    const amountsWeekly = (apiQuota && typeof apiQuota.weekly_remaining === 'number')
      ? `${apiQuota.weekly_remaining}% remaining`
      : isLocal
        ? `${formatCompactNumber(rtkSpend ? rtkSpend.tokensWeekly : data.tokensWeekly)} tokens · ${formatCurrency(rtkSpend ? rtkSpend.costWeekly : data.costWeekly)}`
        : `${formatCurrency(data.costWeekly)} / ${formatCurrency(limitWeekly)}`;

    // Format a percentage for display: values between 0 and 1 show as "<1%"
    // instead of rounding to "0%" when there is real non-zero spend.
    const fmtPct = (pct) => (pct > 0 && pct < 1) ? '<1' : pct.toFixed(0);

    // Budget-exhaustion forecast — only shown when barPct > 20% (enough burn
    // history) and the projection falls inside the current window.
    const forecastMs5h = barPct5h > 20
      ? QuotaUtils.calcForecast(data.cost5h, limit5h, data.earliest5hTimestamp, reset5hMs, now)
      : null;
    const forecastMs_wk = barPctWeekly > 20
      ? QuotaUtils.calcForecast(data.costWeekly, limitWeekly, data.earliestWeeklyTimestamp, resetWeeklyMs, now)
      : null;
    const fmtForecast = (ms) => ms
      ? new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : null;
    const forecast5hLabel    = fmtForecast(forecastMs5h);
    const forecastWeeklyLabel = fmtForecast(forecastMs_wk);

    const card = document.createElement('div');
    card.className = 'card brand-card';
    card.style.setProperty('--brand-color', getBrandColor(bKey));

    card.innerHTML = `
      <div class="brand-card-header">
        <span class="brand-name">${escapeHtml(meta.name)}</span>
        <span class="brand-cost-title">${rtkSpend ? rtkSpend.requestsWeekly : data.requests} reqs</span>
      </div>

      <div class="rolling-limits-stack" style="margin-top: 0; border-top: none; padding-top: 0;">
        <!-- 5-Hour rolling limit -->
        <div class="rolling-limit-row">
          <div class="rolling-limit-row-header">
            <span class="rolling-limit-title">5-Hour</span>
            <span class="rolling-limit-amounts">${amounts5h}</span>
            <span style="color: ${style5h.color}; font-weight: 600; font-size: 11px;" title="${isLocal ? 'RTK-tracked usage vs configured spend limit' : ''}">${fmtPct(barPct5h)}%</span>
          </div>
          <div class="brand-limit-bar" title="${escapeHtml(barSourceTooltip(barSource5h))}">
            <div class="brand-limit-fill${style5h.class}" style="width: ${barPct5h}%;"></div>
          </div>
          <span class="reset-badge${style5h.class}" title="${escapeHtml(reset5hTooltip)}">&#x23F1; ${reset5hLabel}</span>
          ${forecast5hLabel ? `<span class="forecast-badge" title="At current burn rate, 5h budget exhausted around ${forecast5hLabel}">⚡ exhausted ~${forecast5hLabel}</span>` : ''}
        </div>

        <!-- Weekly rolling limit -->
        <div class="rolling-limit-row">
          <div class="rolling-limit-row-header">
            <span class="rolling-limit-title">Weekly</span>
            <span class="rolling-limit-amounts">${amountsWeekly}</span>
            <span style="color: ${styleWeekly.color}; font-weight: 600; font-size: 11px;" title="${isLocal ? 'RTK-tracked usage vs configured spend limit' : ''}">${fmtPct(barPctWeekly)}%</span>
          </div>
          <div class="brand-limit-bar" title="${escapeHtml(barSourceTooltip(barSourceWeekly))}">
            <div class="brand-limit-fill${styleWeekly.class}" style="width: ${barPctWeekly}%;"></div>
          </div>
          <span class="reset-badge${styleWeekly.class}" title="${escapeHtml(resetWeeklyTooltip)}">&#x23F1; ${resetWeeklyLabel}</span>
          ${forecastWeeklyLabel ? `<span class="forecast-badge" title="At current burn rate, weekly budget exhausted around ${forecastWeeklyLabel}">⚡ exhausted ~${forecastWeeklyLabel}</span>` : ''}
        </div>
      </div>
    `;
    elements.brandCardsContainer.appendChild(card);
  });
}

function renderTable(brandData) {
  elements.tableBody.innerHTML = '';
  
  const items = Object.values(brandData);
  
  // Sorting logic
  const sortKey = state.currentSort.key;
  const dir = state.currentSort.direction === 'asc' ? 1 : -1;
  
  items.sort((a, b) => {
    let valA, valB;
    if (sortKey === 'brand') {
      const brandKeys = Object.keys(state.brandMetadata);
      valA = brandKeys.indexOf(a.key);
      valB = brandKeys.indexOf(b.key);
    } else if (sortKey === 'requests') {
      valA = a.requests;
      valB = b.requests;
    } else if (sortKey === 'input') {
      valA = a.inputTokens;
      valB = b.inputTokens;
    } else if (sortKey === 'output') {
      valA = a.outputTokens;
      valB = b.outputTokens;
    } else if (sortKey === 'saved') {
      valA = a.savedTokens;
      valB = b.savedTokens;
    } else if (sortKey === 'cost') {
      valA = a.cost;
      valB = b.cost;
    } else if (sortKey === 'savings') {
      valA = a.savings;
      valB = b.savings;
    }
    
    if (valA < valB) return -1 * dir;
    if (valA > valB) return 1 * dir;
    return 0;
  });
  
  items.forEach(data => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <div class="table-brand-cell">
          <span class="badge-brand-dot" style="background-color: ${data.color}"></span>
          ${escapeHtml(data.name)}
        </div>
      </td>
      <td class="font-mono-val">${formatNumber(data.requests)}</td>
      <td class="font-mono-val">${formatNumber(data.inputTokens)}</td>
      <td class="font-mono-val">${formatNumber(data.outputTokens)}</td>
      <td class="font-mono-val text-success">${formatNumber(data.savedTokens)}</td>
      <td class="font-mono-val">${formatCurrency(data.cost)}</td>
      <td class="font-mono-val savings-highlight">${formatCurrency(data.savings)}</td>
    `;
    elements.tableBody.appendChild(tr);
  });
}

// 4. TIMER & AUTO-REFRESH SYSTEM
function startCountdownTimer() {
  if (refreshTimerIntervalId) clearInterval(refreshTimerIntervalId);
  
  refreshTimer = getRefreshInterval();
  updateTimerUI();
  
  refreshTimerIntervalId = setInterval(() => {
    refreshTimer--;
    updateTimerUI();
    
    if (refreshTimer <= 0) {
      fetchRealRTKData();
      fetchBrandQuotas();
      fetchAgentUsage();
      fetchProjectData();
      stampLastUpdated();
      scheduleDashboardRender();
      refreshTimer = getRefreshInterval();
    }
  }, 1000);
}

function getRefreshInterval() {
  // Progressive refresh: when any brand is >80% on 5h bar, refresh every 10s
  if (state.brandQuotas) {
    for (const brand of Object.keys(state.brandMetadata)) {
      const q = state.brandQuotas[brand];
      if (!q) continue;
      const meta = state.brandMetadata[brand];
      const limit5h = meta.limit5h > 0 ? meta.limit5h : 2.00;
      // Use spend % for RTK-based brands, API used % for percent-based
      let pct = 0;
      if (q.unit === 'percent' && typeof q.remaining === 'number') {
        pct = Math.max(0, 100 - q.remaining);
      } else if (q.unit === 'requests' && typeof q.remaining === 'number' && typeof q.limit_value === 'number' && q.limit_value > 0) {
        pct = ((q.limit_value - q.remaining) / q.limit_value) * 100;
      }
      if (pct > 80) return 10;
    }
  }
  return REFRESH_INTERVAL_SECONDS;
}

function stampLastUpdated() {
  if (!elements.lastUpdatedText) return;
  const now = new Date();
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  elements.lastUpdatedText.textContent = `Updated ${time}`;
}

function updateTimerUI() {
  const total = getRefreshInterval();
  elements.timerText.textContent = `Refreshes in ${refreshTimer}s`;

  // Circle stroke math (total stroke size is ~44px)
  const offset = 44 - (44 * (refreshTimer / total));
  elements.timerProgressRing.style.strokeDashoffset = offset;
}

// 5. SIMULATION SYSTEMS
function scheduleNextSimulation() {
  if (simulationTimeoutId) clearTimeout(simulationTimeoutId);
  if (!state.isAutoSimulating) return;

  // Random delay between SIM_DELAY_MIN_MS and SIM_DELAY_MAX_MS for organic feel
  const range = SIM_DELAY_MAX_MS - SIM_DELAY_MIN_MS;
  const nextDelayMs = Math.floor(Math.random() * range) + SIM_DELAY_MIN_MS;

  simulationTimeoutId = setTimeout(() => {
    if (!state.isAutoSimulating) return;

    triggerRandomMockRequest();
    scheduleNextSimulation();
  }, nextDelayMs);
}

function triggerRandomMockRequest() {
  const brands = Object.keys(state.brandMetadata);
  const selectedBrand = brands[Math.floor(Math.random() * brands.length)];

  // Logical token distribution
  // Input: 500 - 15000 tokens
  const inputTokens = Math.floor(Math.random() * 14500) + 500;
  // Output: 100 - 4000 tokens
  const outputTokens = Math.floor(Math.random() * 3900) + 100;
  // Cache hit rate (0-45% for all brands)
  const hitProbability = Math.floor(Math.random() * 45);

  const savedTokens = Math.floor(inputTokens * (hitProbability / 100));

  addRequest(selectedBrand, inputTokens, outputTokens, savedTokens);
}

function addRequest(brandKey, inputTokens, outputTokens, savedTokens) {
  const metadata = state.brandMetadata[brandKey];
  if (!metadata) return;

  // Calculate cost (ADR-0003: disjoint model, inputTokens is the billed amount)
  const cost = ((inputTokens * metadata.inputCost) + (outputTokens * metadata.outputCost)) / 1000000;
  const savings = ((savedTokens * metadata.inputCost)) / 1000000;

  const newReq = {
    id: 'req_' + Math.random().toString(36).substring(2, 11),
    timestamp: Date.now(),
    brand: brandKey,
    inputTokens,
    outputTokens,
    savedTokens,
    cost: parseFloat(cost.toFixed(6)),
    savings: parseFloat(savings.toFixed(6))
  };

  state.requests.push(newReq);

  // Truncate memory if request log gets extremely large
  if (state.requests.length > MAX_REQUESTS_RETAINED) {
    state.requests.shift();
  }

  // Save state
  localStorage.setItem('atm_requests', JSON.stringify(state.requests));
  calculateAndRenderDashboard();

  // Real-time console log updates immediately!
  const totalAttemptedInput = inputTokens + savedTokens;
  const savedPercent = totalAttemptedInput > 0 ? ((savedTokens / totalAttemptedInput) * 100).toFixed(0) : '0';

  logEvent(
    metadata.name,
    `API call: Input <span class="highlight-tokens">${formatCompactNumber(inputTokens)}</span> tkn (Saved <span class="highlight-savings">${formatCompactNumber(savedTokens)}</span> tkn, ${savedPercent}%) | Output <span class="highlight-tokens">${formatCompactNumber(outputTokens)}</span> tkn. Cost: <span class="highlight-cost">${formatCurrency(cost)}</span> (Saved <span class="highlight-savings">${formatCurrency(savings)}</span>)`
  );
}

function generateInitialMockHistory() {
  logEvent('SYSTEM', 'Generating pre-populated analytics history...');

  const brands = Object.keys(state.brandMetadata);
  const llmBrands = brands.filter(b => b !== 'rtk');
  // Generate SIM_HISTORY_PRELOAD logs spread over the last 2 days
  for (let i = 0; i < SIM_HISTORY_PRELOAD; i++) {
    const brandKey = llmBrands[Math.floor(Math.random() * llmBrands.length)];
    const metadata = state.brandMetadata[brandKey];

    const inputTokens = Math.floor(Math.random() * 8000) + 400;
    const outputTokens = Math.floor(Math.random() * 2000) + 100;
    const hitProbability = Math.floor(Math.random() * 35);
    const savedTokens = Math.floor(inputTokens * (hitProbability / 100));

    // Calculate cost (ADR-0003: disjoint model, inputTokens is the billed amount)
    const cost = ((inputTokens * metadata.inputCost) + (outputTokens * metadata.outputCost)) / 1000000;
    const savings = ((savedTokens * metadata.inputCost)) / 1000000;

    state.requests.push({
      id: 'mock_' + i,
      timestamp: Date.now() - (SIM_HISTORY_PRELOAD - i) * 60000 * 30, // 30 mins intervals
      brand: brandKey,
      inputTokens,
      outputTokens,
      savedTokens,
      cost: parseFloat(cost.toFixed(6)),
      savings: parseFloat(savings.toFixed(6))
    });
  }

  localStorage.setItem('atm_requests', JSON.stringify(state.requests));
  calculateAndRenderDashboard();
  logEvent('SYSTEM', 'Pre-populated mock history successfully generated.');
}

// 6. LOGGER EVENT WRITER

// Build a console line via DOM construction (safe — no innerHTML for untrusted data).
// `parts` is an array of either {html: '...'} (trusted) or {text: '...'} (escaped).
function appendConsoleLine(source, parts) {
  const line = document.createElement('div');
  line.className = 'console-line';

  const timeStr = new Date().toLocaleTimeString();

  const timeSpan = document.createElement('span');
  timeSpan.className = 'console-timestamp';
  timeSpan.textContent = `[${timeStr}]`;
  line.appendChild(timeSpan);

  const brandSpan = document.createElement('span');
  brandSpan.className = 'console-brand-tag';
  brandSpan.style.color = (source === 'SYSTEM') ? FALLBACK_BRAND_COLOR : getBrandColor(source.toLowerCase());
  brandSpan.textContent = `${source}:`;
  line.appendChild(brandSpan);

  const msgSpan = document.createElement('span');
  msgSpan.className = 'console-msg';
  parts.forEach(part => {
    if (part.html !== undefined) {
      // Trusted, internal-only content (system events, formatted sim output)
      msgSpan.insertAdjacentHTML('beforeend', part.html);
    } else if (part.text !== undefined) {
      const seg = document.createElement('span');
      if (part.cls) seg.className = part.cls;
      seg.textContent = part.text;
      msgSpan.appendChild(seg);
    }
  });
  line.appendChild(msgSpan);

  elements.consoleLogsStream.appendChild(line);
  elements.consoleLogsStream.scrollTop = elements.consoleLogsStream.scrollHeight;

  // Prune DOM to prevent unbounded growth
  while (elements.consoleLogsStream.children.length > MAX_CONSOLE_LINES) {
    elements.consoleLogsStream.removeChild(elements.consoleLogsStream.firstChild);
  }
}

// Trusted HTML helper. Use only for system-generated content; never with user input.
function logEvent(source, htmlMsg) {
  appendConsoleLine(source, [{ html: htmlMsg }]);
}

// Safe helper. Use for any message that includes untrusted text (e.g. shell command strings).
function logEventSafe(source, segments) {
  appendConsoleLine(source, segments);
}

// 7. EVENT LISTENERS SETUP
function setupEventListeners() {
  // Theme Switching
  if (elements.themeToggleBtn) elements.themeToggleBtn.addEventListener('click', () => {
    const nextTheme = state.theme === 'light' ? 'dark' : 'light';
    state.theme = nextTheme;
    localStorage.setItem('atm_theme', nextTheme);
    document.documentElement.setAttribute('data-theme', nextTheme);
    if (elements.themeIcon) elements.themeIcon.textContent = nextTheme === 'dark' ? '☀️' : '🌙';
    logEvent('SYSTEM', `UI visual theme toggled to ${nextTheme} mode.`);
  });
  
  // Clear Logs — clears both sim and real data stores
  if (elements.clearLogsBtn) elements.clearLogsBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to reset all token tracking usage logs? This clears LocalStorage.')) {
      state.requests = [];
      state.realCommands = [];
      localStorage.setItem('atm_requests', JSON.stringify([]));
      calculateAndRenderDashboard();
      if (elements.consoleLogsStream) elements.consoleLogsStream.innerHTML = '';
      logEvent('SYSTEM', 'Reset complete. Usage charts and logs cleared.');
    }
  });
  
  // Export CSV
  if (elements.exportCsvBtn) elements.exportCsvBtn.addEventListener('click', () => {
    exportToCSV();
  });
  
  // Modals Open & Close
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const modalId = e.currentTarget.getAttribute('data-close');
      closeModal(modalId);
    });
  });
  
  if (elements.openSettingsModalBtn) elements.openSettingsModalBtn.addEventListener('click', () => {
    openModal('settings-modal');
  });

  // Close Modals on clicking outside overlay or pressing Escape
  window.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) {
      closeModal(e.target.id);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay.active').forEach(modal => closeModal(modal.id));
    }
  });
  
  // Form submission: Pricing Rates & API Keys
  if (elements.pricingRatesForm) elements.pricingRatesForm.addEventListener('submit', (e) => {
    e.preventDefault();
    let hasInvalid = false;
    Object.keys(state.brandMetadata).forEach(bKey => {
      const inputVal = parseFloat(document.getElementById(`rate-${bKey}-input`).value);
      const outputVal = parseFloat(document.getElementById(`rate-${bKey}-output`).value);
      const limit5hVal = parseFloat(document.getElementById(`rate-${bKey}-limit5h`).value);
      const limitWeeklyVal = parseFloat(document.getElementById(`rate-${bKey}-limitWeekly`).value);

      // Validate before assignment to prevent NaN propagation
      if (Number.isFinite(inputVal) && inputVal >= 0) state.brandMetadata[bKey].inputCost = inputVal;
      else hasInvalid = true;
      if (Number.isFinite(outputVal) && outputVal >= 0) state.brandMetadata[bKey].outputCost = outputVal;
      else hasInvalid = true;
      if (Number.isFinite(limit5hVal) && limit5hVal > 0) state.brandMetadata[bKey].limit5h = limit5hVal;
      else hasInvalid = true;
      if (Number.isFinite(limitWeeklyVal) && limitWeeklyVal > 0) state.brandMetadata[bKey].limitWeekly = limitWeeklyVal;
      else hasInvalid = true;
    });

    if (hasInvalid) {
      logEvent('SYSTEM', 'Some pricing fields were invalid; previous values retained for those fields.');
    }

    localStorage.setItem('atm_brand_metadata', JSON.stringify(state.brandMetadata));

    // Save API keys via per-key endpoint — never echo full keys in browser memory
    const keyUpdates = [
      { name: 'ANTHROPIC_API_KEY', value: elements.tokenAnthropic.value.trim() },
      { name: 'GEMINI_API_KEY', value: elements.tokenGemini.value.trim() },
      { name: 'GLM_API_KEY', value: elements.tokenGlm.value.trim() },
      { name: 'MINIMAX_API_KEY', value: elements.tokenMinimax.value.trim() }
    ];

    Promise.all(keyUpdates.map(k =>
      fetch(`/api/env/key?key=${encodeURIComponent(k.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: k.value })
      }).then(res => res.json()).catch(err => ({ success: false, error: err.message }))
    )).then(results => {
      const failed = results.filter(r => !r.success);
      if (failed.length === 0) {
        logEvent('SYSTEM', 'Saved environment API keys/tokens to local .env file.');
      } else {
        logEvent('SYSTEM', `Error saving ${failed.length} key(s): ${failed[0].error}`);
      }
    });

    closeModal('settings-modal');

    calculateAndRenderDashboard();
    logEvent('SYSTEM', 'Custom LLM pricing models, limits, and API keys updated.');
  });

  // Table Sorting headers click
  document.querySelectorAll('.sortable-header').forEach(header => {
    header.addEventListener('click', (e) => {
      const key = e.currentTarget.getAttribute('data-sort');
      if (state.currentSort.key === key) {
        // Toggle direction
        state.currentSort.direction = state.currentSort.direction === 'asc' ? 'desc' : 'asc';
      } else {
        state.currentSort.key = key;
        state.currentSort.direction = key === 'brand' ? 'asc' : 'desc'; // Default to asc for brand, desc for metrics
      }
      
      calculateAndRenderDashboard();
    });
  });

}

function updateSimButtonUI(isActive) {
  if (isActive) {
    if (elements.simStatusIcon) elements.simStatusIcon.textContent = '⏸';
    if (elements.simStatusText) elements.simStatusText.textContent = 'Pause Simulation';
    if (elements.simActivityDot) elements.simActivityDot.className = 'status-indicator';
    if (elements.consoleStatusIndicator) elements.consoleStatusIndicator.className = 'status-indicator';
    if (elements.valSimulationSpeed) elements.valSimulationSpeed.textContent = 'Auto-simulation active (8-20s)';
  } else {
    if (elements.simStatusIcon) elements.simStatusIcon.textContent = '▶';
    if (elements.simStatusText) elements.simStatusText.textContent = 'Resume Simulation';
    if (elements.simActivityDot) elements.simActivityDot.className = 'status-indicator paused';
    if (elements.consoleStatusIndicator) elements.consoleStatusIndicator.className = 'status-indicator paused';
    if (elements.valSimulationSpeed) elements.valSimulationSpeed.textContent = 'Auto-simulation paused';
  }
}

function openModal(id) {
  const modal = document.getElementById(id);
  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');
  
  // Focus logic inside modal
  const focusable = modal.querySelectorAll('input, select, button');
  if (focusable.length > 0) focusable[0].focus();
}

function closeModal(id) {
  const modal = document.getElementById(id);
  modal.classList.remove('active');
  modal.setAttribute('aria-hidden', 'true');
}

function buildSettingsFormFields() {
  elements.pricingRatesFormFields.innerHTML = '';
  
  Object.keys(state.brandMetadata).forEach(bKey => {
    const meta = state.brandMetadata[bKey];
    const brandColor = getBrandColor(bKey);

    const fieldset = document.createElement('div');
    fieldset.style.border = '1px solid var(--border)';
    fieldset.style.borderRadius = 'var(--radius-sm)';
    fieldset.style.padding = '12px';

    fieldset.innerHTML = `
      <h4 style="font-size: 13px; font-weight: 600; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
        <span class="badge-brand-dot" style="background-color: ${brandColor}"></span>
        ${escapeHtml(meta.name)}
      </h4>
      <div class="form-row-grid">
        <div class="form-group">
          <label for="rate-${bKey}-input">Input Rate ($/1M tkn)</label>
          <input type="number" id="rate-${bKey}-input" step="0.01" min="0" value="${meta.inputCost}">
        </div>
        <div class="form-group">
          <label for="rate-${bKey}-output">Output Rate ($/1M tkn)</label>
          <input type="number" id="rate-${bKey}-output" step="0.01" min="0" value="${meta.outputCost}">
        </div>
      </div>
      <div class="form-row-grid" style="margin-top: 8px;">
        <div class="form-group">
          <label for="rate-${bKey}-limit5h">5h Spend Limit ($)</label>
          <input type="number" id="rate-${bKey}-limit5h" step="0.1" min="0.1" value="${meta.limit5h || 2.00}">
        </div>
        <div class="form-group">
          <label for="rate-${bKey}-limitWeekly">Weekly Spend Limit ($)</label>
          <input type="number" id="rate-${bKey}-limitWeekly" step="1" min="1" value="${meta.limitWeekly || 15.00}">
        </div>
      </div>

    `;
    elements.pricingRatesFormFields.appendChild(fieldset);
  });
}


function exportToCSV() {
  const rows = [
    ['Brand', 'Requests', 'Input Tokens', 'Output Tokens', 'Saved Tokens', 'Actual Cost (USD)', 'Saved Cost (USD)']
  ];

  // Compile row values
  Object.keys(state.brandMetadata).forEach(bKey => {
    const name = state.brandMetadata[bKey].name;
    const reqs = getActiveRequests().filter(r => r.brand === bKey);

    let input = 0, output = 0, saved = 0, cost = 0, savings = 0;
    reqs.forEach(r => {
      input += r.inputTokens;
      output += r.outputTokens;
      saved += r.savedTokens;
      cost += r.cost;
      savings += r.savings;
    });

    rows.push([
      name,
      reqs.length,
      input,
      output,
      saved,
      cost.toFixed(6),
      savings.toFixed(6)
    ]);
  });

  const csvString = rows.map(e => e.map(val => `"${val}"`).join(",")).join("\n");
  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `ai_token_monitor_stats_${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  logEvent('SYSTEM', 'Exported token statistics spreadsheet to CSV download.');
}

// 8. HELPER FORMATTERS (delegated to lib/format.js — window.FormatUtils)
function formatNumber(num) { return FormatUtils.formatNumber(num); }
function formatCompactNumber(num) { return FormatUtils.formatCompactNumber(num); }
function formatCurrency(val) { return FormatUtils.formatCurrency(val); }
function formatTimeRemaining(ms) { return FormatUtils.formatTimeRemaining(ms); }

// 9. SETTINGS & ENV UTILITIES

function setupTabs() {
  elements.tabRatesBtn.addEventListener('click', () => {
    elements.tabRatesBtn.classList.add('active');
    elements.tabTokensBtn.classList.remove('active');
    elements.tabContentRates.classList.add('active');
    elements.tabContentTokens.classList.remove('active');
    elements.tabRatesBtn.setAttribute('aria-selected', 'true');
    elements.tabTokensBtn.setAttribute('aria-selected', 'false');
  });

  elements.tabTokensBtn.addEventListener('click', () => {
    elements.tabTokensBtn.classList.add('active');
    elements.tabRatesBtn.classList.remove('active');
    elements.tabContentTokens.classList.add('active');
    elements.tabContentRates.classList.remove('active');
    elements.tabTokensBtn.setAttribute('aria-selected', 'true');
    elements.tabRatesBtn.setAttribute('aria-selected', 'false');
  });
}

function fetchAPIKeys() {
  fetch('/api/env')
    .then(res => res.json())
    .then(data => {
      if (data.ANTHROPIC_API_KEY && elements.tokenAnthropic) elements.tokenAnthropic.value = data.ANTHROPIC_API_KEY;
      if (data.GEMINI_API_KEY && elements.tokenGemini) elements.tokenGemini.value = data.GEMINI_API_KEY;
      if (data.GLM_API_KEY && elements.tokenGlm) elements.tokenGlm.value = data.GLM_API_KEY;
      if (data.MINIMAX_API_KEY && elements.tokenMinimax) elements.tokenMinimax.value = data.MINIMAX_API_KEY;
    })
    .catch(err => console.error('Failed to load local API keys from backend:', err));
}

function fetchBrandQuotas() {
  fetch('/api/seed-quotas')
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then(data => {
      if (data.success && data.quotas) {
        state.brandQuotas = {};
        data.quotas.forEach(q => {
          if (typeof q.raw_json === 'string') {
            try { q.raw_json = JSON.parse(q.raw_json); } catch(e) { /* keep as-is */ }
          }
          state.brandQuotas[q.brand] = q;
        });
        scheduleDashboardRender();
      }
    })
    .catch(err => {
      console.warn('Failed to fetch brand quotas:', err);
    });
}

function fetchAgentUsage() {
  fetch('/api/agent-usage')
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then(data => {
      state.agentUsage = data;
      scheduleDashboardRender();
    })
    .catch(err => {
      console.warn('Failed to fetch agent usage:', err);
    });
}

function fetchProjectData() {
  fetch('/api/rtk/projects')
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then(data => {
      if (data && data.projects) {
        renderProjectBreakdown(data.projects);
      }
    })
    .catch(err => {
      console.warn('Failed to fetch project data:', err);
    });
}

function renderProjectBreakdown(projects) {
  if (!elements.projectsTableContainer || !elements.projectsSection) return;

  if (!projects || projects.length === 0) {
    elements.projectsSection.style.display = 'none';
    return;
  }

  // Show only rows with a real project_path (not RTK proxy)
  const custom = projects.filter(p => p.project !== '(rtk-proxy)');
  if (custom.length === 0) {
    elements.projectsSection.style.display = 'none';
    return;
  }

  elements.projectsSection.style.display = '';

  // Group by project path
  const groups = {};
  custom.forEach(p => {
    if (!groups[p.project]) {
      groups[p.project] = [];
    }
    groups[p.project].push(p);
  });

  const htmlRows = [];
  Object.keys(groups).sort().forEach(projectPath => {
    const brandDataList = groups[projectPath];
    
    let totalRequests = 0;
    let totalTokens = 0;
    let totalCost = 0;

    const brandRowsHtml = brandDataList.map(p => {
      const brandKey = p.brand || detectBrand(p.sample_cmd) || 'claude';
      const meta = state.brandMetadata[brandKey] || {};
      const cost = ((p.input_tokens * (meta.inputCost || 3))
                  + (p.output_tokens * (meta.outputCost || 15))) / 1000000;
      const brandName = meta.name || brandKey;
      const brandColor = meta.color || FALLBACK_BRAND_COLOR;
      const tokens = p.input_tokens + p.output_tokens;

      totalRequests += p.requests;
      totalTokens += tokens;
      totalCost += cost;

      return `<tr class="project-brand-row">
        <td class="project-brand-cell">
          <div style="display: flex; align-items: center; gap: 6px; padding-left: 20px;">
            <span class="badge-brand-dot" style="background-color: ${brandColor}; width: 6px; height: 6px; border-radius: 50%;"></span>
            <span>${escapeHtml(brandName)}</span>
          </div>
        </td>
        <td class="font-mono-val">${formatNumber(p.requests)}</td>
        <td class="font-mono-val">${formatNumber(tokens)}</td>
        <td class="font-mono-val">${formatCurrency(cost)}</td>
      </tr>`;
    }).join('');

    const headerHtml = `<tr class="project-header-row">
      <td class="project-name-cell" title="${escapeHtml(projectPath)}">${escapeHtml(shortPath(projectPath))}</td>
      <td class="font-mono-val" style="font-weight: 600;">${formatNumber(totalRequests)}</td>
      <td class="font-mono-val" style="font-weight: 600;">${formatNumber(totalTokens)}</td>
      <td class="font-mono-val" style="font-weight: 600;">${formatCurrency(totalCost)}</td>
    </tr>`;

    htmlRows.push(headerHtml);
    htmlRows.push(brandRowsHtml);
  });

  elements.projectsTableContainer.innerHTML = `
    <table class="projects-table">
      <thead>
        <tr>
          <th>Project / Brand</th>
          <th>Reqs</th>
          <th>Tokens (7d)</th>
          <th>Cost (7d)</th>
        </tr>
      </thead>
      <tbody>
        ${htmlRows.join('')}
      </tbody>
    </table>`;
}

function shortPath(p) {
  if (!p) return '';
  return p.split('/').filter(Boolean).slice(-2).join('/');
}

function getActiveRequests() {
  return state.monitorMode === 'sim' ? state.requests : state.realCommands;
}

let lastSeenCommandId = 0;
let rtkEventSource = null;

function fetchRealRTKData(forceRefresh = false) {
  if (forceRefresh) lastSeenCommandId = 0;
  const url = lastSeenCommandId > 0 ? `/api/rtk?since=${lastSeenCommandId}` : '/api/rtk';
  fetch(url)
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then(data => {
      if (data.error) {
        logEvent('SYSTEM', `RTK load status: ${data.error}`);
        return;
      }

      const commands = data.commands || [];
      const mappedRequests = [];

      // Sort by timestamp ascending to process history chronologically
      const sortedCmds = [...commands].sort((a, b) => a.id - b.id);

      const isInitialLoad = lastSeenCommandId === 0;
      // The "last 15" window applies to LLM-classified commands only — shell
      // noise (curl/grep/ls to localhost) shouldn't push real API calls out
      // of the feed. Pre-count LLM commands to get an accurate threshold.
      let llmCount = 0;
      if (isInitialLoad) {
        for (const cmd of sortedCmds) {
          if (detectBrand(cmd.original_cmd)) llmCount++;
        }
      }
      const recentLogThreshold = isInitialLoad ? Math.max(0, llmCount - 15) : 0;
      let llmSeen = 0;

      sortedCmds.forEach((cmd) => {
        const brandKey = detectBrand(cmd.original_cmd);
        if (!brandKey) return; // Skip non-LLM proxy commands
        llmSeen++;
        const meta = state.brandMetadata[brandKey];

        // ADR-0003: disjoint model, input_tokens is the billed amount
        const cost = ((cmd.input_tokens * meta.inputCost) + (cmd.output_tokens * meta.outputCost)) / 1000000;
        const savings = (cmd.saved_tokens * meta.inputCost) / 1000000;

        mappedRequests.push({
          id: 'rtk_' + cmd.id,
          source: 'real',
          timestamp: new Date(cmd.timestamp).getTime(),
          brand: brandKey,
          inputTokens: cmd.input_tokens,
          outputTokens: cmd.output_tokens,
          savedTokens: cmd.saved_tokens,
          cost: parseFloat(cost.toFixed(6)),
          savings: parseFloat(savings.toFixed(6)),
          cmdText: cmd.original_cmd,
          projectPath: cmd.project_path || ''
        });

        // On initial load, log the most recent 15 LLM commands to populate the feed.
        // On subsequent refreshes, log only genuinely new commands.
        const shouldLog = isInitialLoad ? (llmSeen > recentLogThreshold) : (cmd.id > lastSeenCommandId);
        if (shouldLog) {
          const totalAttempted = cmd.input_tokens + cmd.saved_tokens;
          const savedPercent = totalAttempted > 0 ? ((cmd.saved_tokens / totalAttempted) * 100).toFixed(0) : '0';
          const projName = cmd.project_path ? cmd.project_path.split('/').filter(Boolean).pop() : '';
          const projLabel = projName ? `[${projName}] ` : '';
          logEventSafe(meta.name, [
            { text: `[Real] ${projLabel}"` },
            { text: cmd.original_cmd },
            { text: '" | In: ' },
            { text: formatCompactNumber(cmd.input_tokens), cls: 'highlight-tokens' },
            { text: ` (Saved ${savedPercent}%) | Out: ` },
            { text: formatCompactNumber(cmd.output_tokens), cls: 'highlight-tokens' },
            { text: '. Cost: ' },
            { text: formatCurrency(cost), cls: 'highlight-cost' }
          ]);
        }
      });

      if (sortedCmds.length > 0) {
        lastSeenCommandId = sortedCmds[sortedCmds.length - 1].id;
      }

      if (forceRefresh) {
        state.realCommands = mappedRequests;
      } else {
        state.realCommands = state.realCommands.concat(mappedRequests);
      }
      if (state.realCommands.length > MAX_REQUESTS_RETAINED) {
        state.realCommands = state.realCommands.slice(-MAX_REQUESTS_RETAINED);
      }
      scheduleDashboardRender();
    })
    .catch(err => {
      logEvent('SYSTEM', `Failed to connect to RTK backend API: ${err.message}`);
    });
}

let _renderTimer = null;

function scheduleDashboardRender() {
  if (_renderTimer !== null) return; // already scheduled
  _renderTimer = setTimeout(() => {
    _renderTimer = null;
    calculateAndRenderDashboard();
  }, 200);
}

function connectRTKStream() {
  if (rtkEventSource) {
    rtkEventSource.close();
  }

  rtkEventSource = new EventSource('/api/rtk/stream');

  rtkEventSource.onmessage = (event) => {
    try {
      const cmd = JSON.parse(event.data);
      if (cmd.status === 'connected') return;

      const brandKey = detectBrand(cmd.original_cmd);
      if (!brandKey) return; // Skip non-LLM proxy commands
      const meta = state.brandMetadata[brandKey];

      // ADR-0003: disjoint model, input_tokens is the billed amount
      const cost = ((cmd.input_tokens * meta.inputCost) + (cmd.output_tokens * meta.outputCost)) / 1000000;
      const savings = (cmd.saved_tokens * meta.inputCost) / 1000000;

      const newReq = {
        id: 'rtk_' + cmd.id,
        source: 'real',
        timestamp: new Date(cmd.timestamp).getTime(),
        brand: brandKey,
        inputTokens: cmd.input_tokens,
        outputTokens: cmd.output_tokens,
        savedTokens: cmd.saved_tokens,
        cost: parseFloat(cost.toFixed(6)),
        savings: parseFloat(savings.toFixed(6)),
        cmdText: cmd.original_cmd,
        projectPath: cmd.project_path || ''
      };

      const existingIdx = state.realCommands.findIndex(r => r.id === newReq.id);
      if (existingIdx !== -1) {
        state.realCommands[existingIdx] = newReq;
        scheduleDashboardRender();
        if (cmd.project_path) {
          fetchProjectData();
        }
      } else {
        state.realCommands.push(newReq);
        if (state.realCommands.length > MAX_REQUESTS_RETAINED) {
          state.realCommands.shift();
        }

        const totalAttempted = cmd.input_tokens + cmd.saved_tokens;
        const savedPercent = totalAttempted > 0 ? ((cmd.saved_tokens / totalAttempted) * 100).toFixed(0) : '0';
        const projName = cmd.project_path ? cmd.project_path.split('/').filter(Boolean).pop() : '';
        const projLabel = projName ? `[${projName}] ` : '';
        logEventSafe(meta.name, [
          { text: `[Real-Time] ${projLabel}"` },
          { text: cmd.original_cmd },
          { text: '" | In: ' },
          { text: formatCompactNumber(cmd.input_tokens), cls: 'highlight-tokens' },
          { text: ` (Saved ${savedPercent}%) | Out: ` },
          { text: formatCompactNumber(cmd.output_tokens), cls: 'highlight-tokens' },
          { text: '. Cost: ' },
          { text: formatCurrency(cost), cls: 'highlight-cost' }
        ]);

        scheduleDashboardRender();
        if (cmd.project_path) {
          fetchProjectData();
        }
      }
    } catch (e) {
      console.error('Error processing real-time SSE stream packet:', e);
    }
  };

  rtkEventSource.onerror = (err) => {
    console.warn('Real-time SSE stream connection error, retrying...', err);
  };
}

// Brand detection for RTK `original_cmd` strings. Returns null for shell
// commands (git, ls, curl to localhost, etc.) so callers can skip them.
// Delegated to lib/brand-detect.js (window.BrandDetect.detectBrand), which is
// shared between the client and the server.
function detectBrand(cmd) { return BrandDetect.detectBrand(cmd); }

// Run application!
document.addEventListener('DOMContentLoaded', init);
