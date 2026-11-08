// Theme chosen in the header (light, dark, or the system's when nothing is
// saved), applied in <head> before the first paint so the page does not
// flash in the other colours. The switch itself is in common.js.
(() => {
  let theme = null;
  try { theme = localStorage.getItem("nasm.theme"); } catch { }
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
})();
