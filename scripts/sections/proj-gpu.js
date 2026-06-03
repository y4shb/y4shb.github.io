// Thin section shim so main.js's lazy loader (which imports from ./sections/<name>.js)
// can mount the reusable liquid-cooled GPU accelerator component on the DCAuto card.
export { default } from '../components/gpu-accelerator.js';
