// lib/format.js
// Number, currency, and time formatting utilities for the dashboard.
// Browser-only — consumed via window.FormatUtils after <script> loads.
(function (root) {
  root.FormatUtils = {
    formatNumber: function (num) {
      return num.toLocaleString();
    },

    formatCompactNumber: function (num) {
      if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
      if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
      return num.toString();
    },

    formatCurrency: function (val) {
      if (val === 0) return '$0.0000';
      var sign = val < 0 ? '-' : '';
      var abs = Math.abs(val);
      if (abs < 0.01) return sign + '$' + abs.toFixed(5);
      return sign + '$' + abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    },

    formatTimeRemaining: function (ms) {
      if (ms <= 0) return 'soon';
      var days = Math.floor(ms / 86400000);
      var hours = Math.floor((ms % 86400000) / 3600000);
      var mins = Math.floor((ms % 3600000) / 60000);
      if (days > 0) return days + 'd ' + hours + 'h';
      if (hours > 0) return hours + 'h ' + mins + 'm';
      return mins + 'm';
    }
  };
}(typeof self !== 'undefined' ? self : this));
