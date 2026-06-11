// lib/antigravity-parser.js
const fs = require('fs');
const path = require('path');

const ANTIGRAVITY_BRAIN_DIR = '/Users/lifetofree/.gemini/antigravity-cli/brain';

let fsRef = fs;

/**
 * Estimate token counts from text length.
 * Standard heuristic: ~4 characters per token for English text.
 */
function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Parses a single JSONL transcript file and aggregates estimated tokens.
 */
function parseTranscriptFile(filePath) {
  const stats = {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    totalCost: 0
  };

  try {
    if (!fsRef.existsSync(filePath)) {
      return stats;
    }

    const content = fsRef.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    lines.forEach(line => {
      if (!line.trim()) return;

      try {
        const step = JSON.parse(line);

        // Estimate tokens based on step source and content
        if (step.source === 'USER_EXPLICIT' || step.source === 'SYSTEM') {
          // Input prompts/system context
          const text = step.content || '';
          stats.inputTokens += estimateTokens(text);
        } else if (step.source === 'MODEL' || step.source === 'SUBAGENT') {
          // Model response text and tool call contents
          const text = step.content || '';
          stats.outputTokens += estimateTokens(text);

          // If tool calls exist, their arguments are counted as output/input context
          if (step.tool_calls && Array.isArray(step.tool_calls)) {
            step.tool_calls.forEach(tc => {
              if (tc.args) {
                stats.outputTokens += estimateTokens(JSON.stringify(tc.args));
              }
            });
          }
        }
      } catch (err) {
        // Skip malformed lines
      }
    });

    // Approximate Gemini costs: $1.25 per 1M input, $5.00 per 1M output
    stats.totalCost = ((stats.inputTokens * 1.25) + (stats.outputTokens * 5.00)) / 1000000;

  } catch (error) {
    console.error(`Error parsing transcript file ${filePath}:`, error);
  }

  return stats;
}

/**
 * Scans the brain directory and aggregates stats across all conversations.
 */
function parseAllTranscripts() {
  const aggregated = {
    conversationsCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    totalCost: 0,
    sessions: []
  };

  try {
    if (!fsRef.existsSync(ANTIGRAVITY_BRAIN_DIR)) {
      return aggregated;
    }

    const items = fsRef.readdirSync(ANTIGRAVITY_BRAIN_DIR);

    items.forEach(item => {
      const dirPath = path.join(ANTIGRAVITY_BRAIN_DIR, item);
      const stat = fsRef.statSync(dirPath);

      if (stat.isDirectory()) {
        const transcriptPath = path.join(dirPath, '.system_generated', 'logs', 'transcript.jsonl');
        
        if (fsRef.existsSync(transcriptPath)) {
          const stats = parseTranscriptFile(transcriptPath);
          
          aggregated.conversationsCount++;
          aggregated.inputTokens += stats.inputTokens;
          aggregated.outputTokens += stats.outputTokens;
          aggregated.cachedTokens += stats.cachedTokens;
          aggregated.totalCost += stats.totalCost;

          aggregated.sessions.push({
            conversationId: item,
            lastModified: fsRef.statSync(transcriptPath).mtimeMs,
            ...stats
          });
        }
      }
    });
  } catch (error) {
    console.error('Error scanning Antigravity brain directory:', error);
  }

  return aggregated;
}

module.exports = {
  parseTranscriptFile,
  parseAllTranscripts,
  _setFs: (mockFs) => { fsRef = mockFs; }
};

