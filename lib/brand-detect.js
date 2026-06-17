// lib/brand-detect.js
// Brand detection for RTK original_cmd strings. Returns null for shell
// commands (git, ls, curl to localhost, etc.). Callers decide what to do:
//   - lib/rtk-metrics.js: falls back to 'claude' when the row has token data
//     (unmatched rows with tokens are Claude Code tool-use calls).
//   - app.js live feed: keeps null strict so shell noise stays out of the feed.
// Browser-only — consumed via window.BrandDetect after <script> loads.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BrandDetect = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  // Shell command prefixes that should never be classified as LLM API calls.
  var SHELL_PREFIXES = ['grep', 'rg', 'cat', 'ls', 'find', 'git', 'sed', 'awk', 'head', 'tail', 'wc', 'sort', 'uniq', 'diff', 'cp', 'mv', 'rm', 'touch', 'mkdir', 'chmod', 'chown', 'echo', 'printf', 'node', 'npm', 'npx', 'python', 'python3', 'pip', 'pip3', 'rustc', 'cargo', 'go', 'make', 'cmake', 'docker', 'kubectl', 'ssh', 'scp', 'rsync', 'tar', 'zip', 'unzip', 'open', 'code', 'vim', 'nano', 'less', 'more', 'man', 'which', 'whereis', 'stat', 'du', 'df', 'ps', 'top', 'kill', 'killall', 'launchctl', 'defaults', 'pbcopy', 'pbpaste', 'xclip', 'xsel', 'export', 'source', 'cd', 'pwd', 'whoami', 'env', 'set', 'unset', 'alias', 'history', 'clear', 'reset', 'true', 'false'];

  // Non-LLM hostnames that appear in curl commands but aren't API calls.
  // Brand names may appear in the URL path (e.g. firebasedatabase.app/.../claude.json)
  // without being actual provider API traffic.
  var NON_LLM_HOSTS = ['localhost', '127.0.0.1', 'firebasedatabase.app', 'firebaseio.com'];

  function isShellCommand(c) {
    var firstWord = c.split(/\s+/)[0];
    return SHELL_PREFIXES.indexOf(firstWord) !== -1;
  }

  function isNonLlmUrl(c) {
    return NON_LLM_HOSTS.some(function(h) { return c.indexOf(h) !== -1; });
  }

  return {
    detectBrand: function (cmd) {
      if (!cmd || typeof cmd !== 'string') return null;
      var c = cmd.toLowerCase();

      // Filter out shell commands first — their arguments may contain brand
      // names as search patterns or file paths without being LLM API calls.
      // (e.g. `grep -rn 'claude' app.js`, `cat /tmp/claude-501/...`)
      if (isShellCommand(c)) return null;

      // Filter out non-LLM infrastructure URLs (Firebase, localhost, etc.)
      // whose paths may contain brand names without being provider API calls.
      if (isNonLlmUrl(c)) return null;

      if (c.includes('gemini') || c.includes('google-generative') || c.includes('genai')) return 'gemini';
      if (c.includes('minimax')) return 'minimax';
      if (c.includes('glm') || c.includes('zhipu')) return 'glm';
      if (c.includes('mimo') || c.includes('xiaomi')) return 'mimo';
      if (c.includes('claude') || c.includes('anthropic')) return 'claude';
      return null;
    }
  };
}));
