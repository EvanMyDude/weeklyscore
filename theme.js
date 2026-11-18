// Runs in <head> before first paint so the page never flashes the wrong theme.
// Order: the last choice made with the toggle on this device, then ?theme=
// in the URL, then the operating system setting. app.js owns the toggle and
// writes the same storage key.
(function () {
  var STORAGE_KEY = 'weeklyscore-theme';
  var valid = function (t) { return t === 'light' || t === 'dark'; };
  var theme = null;
  try { theme = window.localStorage.getItem(STORAGE_KEY); } catch (e) { theme = null; }
  if (!valid(theme)) theme = new URLSearchParams(window.location.search).get('theme');
  if (!valid(theme)) {
    var prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    theme = prefersLight ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
