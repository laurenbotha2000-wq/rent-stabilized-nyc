// Theme and marker palette, applied before the page draws so there's no
// flash. Saved per device: theme = auto | light | dark,
// palette = default | cb | ibm | okabe | tol (see style.css).
(() => {
  let t = null, p = null;
  try { t = localStorage.getItem("theme"); p = localStorage.getItem("palette"); } catch { /* storage blocked */ }
  const root = document.documentElement;
  if (t === "light" || t === "dark") root.dataset.theme = t;
  if (["cb", "ibm", "okabe", "tol"].includes(p)) root.dataset.palette = p;
})();
