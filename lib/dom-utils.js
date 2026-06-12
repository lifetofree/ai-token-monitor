// lib/dom-utils.js
// DOM helpers: HTML escaping and safe console log writer.
// Browser-only — consumed via window.DomUtils after <script> loads.
(function (root) {
  root.DomUtils = {
    escapeHtml: function (str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
  };
}(typeof self !== 'undefined' ? self : this));
