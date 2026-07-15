// lib/antigravity-parser.js
//
// Parses Antigravity CLI transcript.jsonl files under
// ~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/
// and aggregates per-conversation and global token counts.
//
// Token counting has two modes:
//   1. Heuristic (default)            — Math.ceil(text.length / 4)
//   2. Real Gemini API (when key set) — uses @google/generative-ai's
//                                       model.countTokens(text) for exact
//                                       counts, with a process-local cache.
//
// `_setGeminiKey(key)` switches modes and is the seam tests use to inject
// a mocked Gemini client via `_setGeminiClient({ countTokens })`.

const fs = require('fs');
const path = require('path');
const os = require('os');

const ANTIGRAVITY_BRAIN_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');

let fsRef = fs;
let geminiKey = null;
let geminiClient = null;          // { countTokens: async (text) => number }
const tokenCountCache = new Map(); // text -> number

// Parser-level cache to skip reading and parsing unchanged transcript files.
const parserCache = new Map();    // key: conversationId, value: { mtimeMs, stats }

/**
 * Heuristic token estimate: ~4 characters per token for English/code text.
 * Used as fallback when no Gemini API key is configured.
 */
function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Returns the active token counter. Uses the real Gemini API when a key
 * has been injected (or detected in GEMINI_API_KEY). Otherwise returns
 * the heuristic. Caller is responsible for awaiting the result.
 *
 * The returned function is always wrapped in (a) the process-local cache
 * and (b) a try/catch that falls back to the heuristic on any error.
 * This is true for both the live Gemini SDK and any client injected via
 * `_setGeminiClient` — the wrapper is the contract.
 */
function getCounter() {
  if (geminiClient) {
    return wrapCounter(geminiClient.countTokens);
  }
  if (geminiKey && !geminiClient) {
    try {
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const g = new GoogleGenerativeAI(geminiKey);
      geminiClient = {
        countTokens: async (text) => {
          const model = g.getGenerativeModel({ model: 'models/gemini-1.5-flash' });
          const res = await model.countTokens(text);
          return (res && typeof res.totalTokens === 'number')
            ? res.totalTokens
            : null; // null signals wrapper to use heuristic
        }
      };
      return wrapCounter(geminiClient.countTokens);
    } catch (err) {
      // SDK load failure — degrade gracefully to heuristic
      geminiClient = null;
      return wrapCounter(null);
    }
  }
  return wrapCounter(null);
}

/**
 * Wraps an upstream counter with the cache + heuristic-fallback contract.
 * `rawCounter` may be `null` (heuristic-only) or `async (text) => number|null`
 * where `null` means "use the heuristic for this text".
 */
function wrapCounter(rawCounter) {
  return async (text) => {
    if (!text) return 0;
    if (tokenCountCache.has(text)) return tokenCountCache.get(text);
    let total = null;
    if (rawCounter) {
      try {
        total = await rawCounter(text);
      } catch (err) {
        total = null; // fall through to heuristic
      }
    }
    if (typeof total !== 'number' || !Number.isFinite(total)) {
      total = estimateTokens(text);
    }
    tokenCountCache.set(text, total);
    return total;
  };
}

/**
 * Counts tokens for a single string. Async to keep the API surface uniform
 * regardless of which mode is active.
 */
async function countTokensFor(text) {
  if (!text || typeof text !== 'string') return 0;
  const counter = getCounter();
  return await counter(text);
}

/**
 * Parses a single JSONL transcript file and aggregates tokens.
 */
async function parseTranscriptFile(filePath) {
  const stats = {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    totalCost: 0
  };

  try {
    const content = await fsRef.promises.readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    // Sequential awaits keep the per-conversation cost bounded by the
    // number of distinct strings (cache hits are O(1)). Parallelising is
    // possible but the API is rate-limited and order doesn't matter here.
    for (const line of lines) {
      if (!line.trim()) continue;

      let step;
      try {
        step = JSON.parse(line);
      } catch (err) {
        continue;
      }

      if (step.source === 'USER_EXPLICIT' || step.source === 'SYSTEM') {
        stats.inputTokens += await countTokensFor(step.content || '');
      } else if (step.source === 'MODEL' || step.source === 'SUBAGENT') {
        stats.outputTokens += await countTokensFor(step.content || '');
        if (step.tool_calls && Array.isArray(step.tool_calls)) {
          for (const tc of step.tool_calls) {
            if (tc.args) {
              stats.outputTokens += await countTokensFor(JSON.stringify(tc.args));
            }
          }
        }
      }
    }

    // Approximate Gemini costs: $1.25 per 1M input, $5.00 per 1M output.
    // These rates match lib/pricing-defaults.js gemini brand.
    stats.totalCost = ((stats.inputTokens * 1.25) + (stats.outputTokens * 5.00)) / 1000000;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return stats;
    }
    throw error;
  }

  return stats;
}

/**
 * Scans the brain directory and aggregates stats across all conversations.
 */
async function parseAllTranscripts() {
  const aggregated = {
    conversationsCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    totalCost: 0,
    sessions: []
  };

  try {
    let items;
    try {
      items = await fsRef.promises.readdir(ANTIGRAVITY_BRAIN_DIR);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return aggregated;
      }
      throw err;
    }

    const promises = items.map(async (item) => {
      const dirPath = path.join(ANTIGRAVITY_BRAIN_DIR, item);
      try {
        const dirStat = await fsRef.promises.stat(dirPath);
        if (!dirStat.isDirectory()) return;

        const transcriptPath = path.join(dirPath, '.system_generated', 'logs', 'transcript.jsonl');

        let fileStat;
        try {
          fileStat = await fsRef.promises.stat(transcriptPath);
        } catch (err) {
          return;
        }

        const lastModified = fileStat.mtimeMs;
        let stats;

        const cached = parserCache.get(item);
        if (cached && cached.mtimeMs === lastModified) {
          stats = cached.stats;
        } else {
          try {
            stats = await parseTranscriptFile(transcriptPath);
            parserCache.set(item, { mtimeMs: lastModified, stats });
          } catch (err) {
            console.error(`Error parsing transcript file ${transcriptPath}:`, err);
            return;
          }
        }

        return {
          conversationId: item,
          lastModified,
          stats
        };
      } catch (err) {
        console.error(`Error processing conversation ${item}:`, err);
      }
    });

    const results = await Promise.all(promises);

    results.forEach(res => {
      if (!res) return;
      aggregated.conversationsCount++;
      aggregated.inputTokens += res.stats.inputTokens;
      aggregated.outputTokens += res.stats.outputTokens;
      aggregated.cachedTokens += res.stats.cachedTokens;
      aggregated.totalCost += res.stats.totalCost;

      aggregated.sessions.push({
        conversationId: res.conversationId,
        lastModified: res.lastModified,
        ...res.stats
      });
    });
  } catch (error) {
    console.error('Error scanning Antigravity brain directory:', error);
  }

  return aggregated;
}

module.exports = {
  parseTranscriptFile,
  parseAllTranscripts,
  countTokensFor,
  estimateTokens,
  _setFs: (mockFs) => {
    fsRef = mockFs;
    parserCache.clear();
  },
  _setGeminiKey: (key) => {
    geminiKey = key || null;
    geminiClient = null;
    tokenCountCache.clear();
  },
  _setGeminiClient: (client) => {
    geminiClient = client || null;
    tokenCountCache.clear();
  },
  _resetTokenCache: () => tokenCountCache.clear()
};
