// tests/escapeHtml.test.js
// Tests for the XSS-prevention helper used by appendConsoleLine in app.js.
// Every {text} segment in the console feed must be passed through escapeHtml
// before insertion; the {html} path is reserved for trusted internal strings
// (e.g. brand labels). See docs/REVIEWS.md R5-S1, R5-S2.

import { describe, it, expect } from 'vitest';

// Mirror of app.js's escapeHtml.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

describe('escapeHtml', () => {
  it('escapes <script> tags', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;'
    );
  });

  it('escapes embedded HTML attributes', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe(
      '&lt;img src=x onerror=alert(1)&gt;'
    );
  });

  it('escapes double quotes (for safe use inside attribute values)', () => {
    expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;');
  });

  it('escapes ampersands', () => {
    expect(escapeHtml('Tom & Jerry')).toBe('Tom &amp; Jerry');
  });

  it('coerces non-strings to string before escaping', () => {
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml(null)).toBe('null');
    expect(escapeHtml(undefined)).toBe('undefined');
  });

  it('leaves safe characters untouched', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
    expect(escapeHtml("it's a test")).toBe("it's a test");
  });

  it('handles the realistic RTK original_cmd injection case', () => {
    // Imagine RTK captured a curl call with a double-quoted body that
    // contains HTML. escapeHtml must neutralise the tags.
    const cmd = 'curl -d "<div>hi</div>" https://api.anthropic.com';
    expect(escapeHtml(cmd)).toBe(
      'curl -d &quot;&lt;div&gt;hi&lt;/div&gt;&quot; https://api.anthropic.com'
    );
  });
});
