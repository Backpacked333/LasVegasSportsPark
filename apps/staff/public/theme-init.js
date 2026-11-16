/* global window, document */
// Applies the stored theme before the first paint, so Legends mode never flashes the light page.
// A separate file (not inline): the dashboard's Content-Security-Policy allows scripts from 'self'
// only. `src/theme/ThemeProvider.tsx` owns the value afterwards.
(function () {
  try {
    if (window.localStorage.getItem('sportspark.theme') === 'legends') {
      document.documentElement.setAttribute('data-theme', 'legends');
    }
  } catch {
    // Storage is blocked: the classic theme stays.
  }
})();
