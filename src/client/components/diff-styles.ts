import { wrapCoreCSS } from '@pierre/diffs';

// @pierre/diffs ships its stylesheet targeting :host (web components);
// rescope it to .diffs-scope for light-DOM embedding and inject it once.
// The sheet also contains bare element rules (`pre, code { display: block }`)
// meant for shadow-DOM isolation — wrap everything in @scope so they can't
// leak into the rest of the document (they used to turn every inline <code>
// on the page into a full-width block).
let injected = false;

export function ensureDiffStyles(): void {
  if (injected) return;
  injected = true;
  const style = document.createElement('style');
  style.dataset.pierreDiffs = '';
  const core = wrapCoreCSS('').replaceAll(':host', '.diffs-scope');
  style.textContent = `@layer base, theme, rendered, unsafe;\n@scope (.diffs-scope) {\n${core}\n}`;
  document.head.appendChild(style);
}
