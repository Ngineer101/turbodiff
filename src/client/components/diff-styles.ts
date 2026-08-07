import { wrapCoreCSS } from '@pierre/diffs';

// @pierre/diffs ships its stylesheet targeting :host (web components);
// rescope it to .diffs-scope for light-DOM embedding and inject it once.
let injected = false;

export function ensureDiffStyles(): void {
	if (injected) return;
	injected = true;
	const style = document.createElement('style');
	style.dataset.pierreDiffs = '';
	style.textContent = wrapCoreCSS('').replaceAll(':host', '.diffs-scope');
	document.head.appendChild(style);
}
