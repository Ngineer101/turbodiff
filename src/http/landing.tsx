// Signed-out HTTP landing page, server-rendered as a hono/jsx component (React
// syntax, stringified in the Worker — no client-side React bundle).
//
// The Three.js scene occupies only the right half of desktop viewports (hidden
// on narrow screens) so it never overlaps the hero copy. It is a floating 3D
// terminal: a glossy dark slab whose screen is a live CanvasTexture where a
// Turbodiff factory run types itself out on loop — plan, generate, review,
// fix, verify, PR — over a scrolling wireframe grid floor. Grainy dark paper,
// cool ink and the brand greens only.
//
// CSS and the client script are kept as plain strings injected with
// dangerouslySetInnerHTML so JSX text escaping can't mangle them. The script
// string must not contain backticks or `${` sequences.

const REPO_URL = 'https://github.com/Ngineer101/turbodiff';

const CSS = `
	:root {
		--bg: #15171c;
		--ink: #e8eaee;
		--muted: #8b919c;
		--green: #3fb950;
		--green-bright: #56d364;
		--red: #f85149;
		--line: #2b2f37;
		--mono: "IBM Plex Mono", ui-monospace, monospace;
	}
	* { box-sizing: border-box; margin: 0; }
	html, body { height: 100%; }
	body {
		background: var(--bg);
		color: var(--ink);
		font: 400 15px/1.6 "IBM Plex Sans", system-ui, sans-serif;
		overflow: hidden;
	}
	/* --- background layers --- */
	#scene {
		position: fixed; top: 0; right: 0; width: 50vw; height: 100vh; display: block;
		-webkit-mask-image: linear-gradient(to right, transparent, #000 22%);
		mask-image: linear-gradient(to right, transparent, #000 22%);
	}
	.vignette {
		position: fixed; inset: 0; pointer-events: none;
		background:
			radial-gradient(130% 100% at 20% 40%, transparent 0%, transparent 55%, rgba(21, 23, 28, 0.7) 100%),
			linear-gradient(to top, rgba(21, 23, 28, 0.85), transparent 25%);
	}
	.grain {
		position: fixed; inset: 0; pointer-events: none; opacity: 0.95; mix-blend-mode: overlay;
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3'/%3E%3CfeColorMatrix values='0 0 0 0 0.5 0 0 0 0 0.52 0 0 0 0 0.56 0 0 0 0.3 0'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E");
	}
	/* --- layout --- */
	.frame {
		position: relative; z-index: 2;
		height: 100dvh;
		display: flex; flex-direction: column;
		padding: clamp(1.25rem, 3vw, 2.5rem) clamp(1.25rem, 4.5vw, 4rem);
	}
	header {
		display: flex; align-items: center; justify-content: space-between;
		animation: rise 0.7s cubic-bezier(0.2, 0.7, 0.2, 1) both;
	}
	.brand { display: flex; align-items: center; gap: 0.7rem; text-decoration: none; }
	.brand img {
		width: 30px; height: 30px;
		filter: invert(1) drop-shadow(0 0 8px rgba(63, 185, 80, 0.5));
		mix-blend-mode: screen;
	}
	.wordmark {
		font-family: var(--mono);
		font-size: 0.95rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink);
	}
	.wordmark b { color: var(--green-bright); font-weight: 500; }
	.nav { display: flex; align-items: center; gap: 1.6rem; }
	.nav a {
		font-family: var(--mono);
		color: var(--muted); text-decoration: none; font-size: 0.85rem;
		border-bottom: 1px solid transparent; transition: color 0.2s, border-color 0.2s;
	}
	.nav a:hover { color: var(--ink); border-color: var(--green); }
	main { flex: 1; display: flex; align-items: center; }
	.hero { max-width: 36rem; }
	@media (min-width: 900px) { .hero { max-width: min(36rem, 48vw); } }
	h1 {
		margin: 0 0 1.1rem -0.04em;
		font-family: "Instrument Serif", Georgia, serif; font-weight: 400;
		font-size: clamp(2.6rem, 6.2vw, 4.4rem); line-height: 1.02; letter-spacing: -0.01em;
		animation: rise 0.7s 0.16s cubic-bezier(0.2, 0.7, 0.2, 1) both;
	}
	h1 em { font-style: italic; color: var(--green-bright); }
	.sub {
		color: var(--muted); max-width: 30rem; font-size: 0.95rem;
		animation: rise 0.7s 0.24s cubic-bezier(0.2, 0.7, 0.2, 1) both;
	}
	.proof-line {
		margin-top: 1.15rem;
		font-family: "Instrument Serif", Georgia, serif; font-style: italic;
		font-size: clamp(1.15rem, 2vw, 1.4rem); line-height: 1.3;
		color: var(--green-bright);
		animation: rise 0.7s 0.28s cubic-bezier(0.2, 0.7, 0.2, 1) both;
	}
	.ledger {
		display: flex; gap: clamp(1rem, 2vw, 1.5rem); flex-wrap: wrap;
		margin-top: 1.7rem;
		animation: rise 0.7s 0.3s cubic-bezier(0.2, 0.7, 0.2, 1) both;
	}
	.ledger .stat {
		font-family: var(--mono);
		border-left: 2px solid rgba(63, 185, 80, 0.45);
		padding-left: 0.7rem;
	}
	.ledger .stat b {
		display: block; font-weight: 500; font-size: 1.2rem; letter-spacing: 0.02em;
		color: var(--ink);
	}
	.ledger .stat span {
		font-size: 0.62rem; letter-spacing: 0.08em; text-transform: uppercase;
		color: var(--muted);
	}
	.cta-row {
		display: flex; align-items: center; gap: 0.9rem; margin-top: 1.9rem; flex-wrap: wrap;
		animation: rise 0.7s 0.32s cubic-bezier(0.2, 0.7, 0.2, 1) both;
	}
	.cta {
		display: inline-flex; align-items: center; gap: 0.6em;
		padding: 0.85rem 1.4rem; border-radius: 8px; text-decoration: none;
		font-weight: 500; font-size: 0.92rem; letter-spacing: 0.02em;
		transition: transform 0.18s cubic-bezier(0.2, 0.7, 0.2, 1), box-shadow 0.18s, background 0.18s, border-color 0.18s;
		background: var(--green); color: #04140a;
		box-shadow: 0 0 0 1px rgba(86, 211, 100, 0.4), 0 8px 30px rgba(63, 185, 80, 0.25);
	}
	.cta:hover {
		transform: translateY(-2px); background: var(--green-bright);
		box-shadow: 0 0 0 1px rgba(86, 211, 100, 0.6), 0 12px 40px rgba(63, 185, 80, 0.4);
	}
	.cta svg { width: 1.1em; height: 1.1em; fill: currentColor; }
	.soon {
		display: inline-flex; align-items: center; gap: 0.6em;
		font-family: var(--mono); font-size: 0.82rem; letter-spacing: 0.08em;
		color: var(--ink); padding: 0.85rem 1.25rem; border-radius: 999px;
		border: 1px solid var(--line); background: rgba(30, 33, 39, 0.7);
	}
	.soon::before {
		content: ""; width: 8px; height: 8px; border-radius: 50%;
		background: var(--green-bright);
		box-shadow: 0 0 10px rgba(86, 211, 100, 0.8);
		animation: soon-pulse 1.8s ease-in-out infinite;
	}
	@keyframes soon-pulse {
		0%, 100% { opacity: 1; transform: scale(1); }
		50% { opacity: 0.4; transform: scale(0.75); }
	}
	.cta-note {
		font-family: var(--mono);
		display: block; margin-top: 0.9rem; color: var(--muted); font-size: 0.8rem;
		animation: rise 0.7s 0.38s cubic-bezier(0.2, 0.7, 0.2, 1) both;
	}
	footer {
		font-family: var(--mono);
		display: flex; gap: 2rem; flex-wrap: wrap;
		color: var(--muted); font-size: 0.78rem; letter-spacing: 0.06em;
		border-top: 1px solid var(--line); padding-top: 1.1rem;
		animation: rise 0.7s 0.44s cubic-bezier(0.2, 0.7, 0.2, 1) both;
	}
	footer span::before { content: "// "; color: var(--green); opacity: 0.7; }
	footer a { color: inherit; text-decoration: none; border-bottom: 1px solid #3a4049; }
	footer a:hover { color: var(--ink); border-color: var(--green); }
	@keyframes rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
	@media (max-width: 899px) {
		#scene { display: none; }
		footer { gap: 0.4rem 1.4rem; }
	}
	@media (max-width: 720px) {
		body { overflow-y: auto; }
		.frame { height: auto; min-height: 100dvh; }
		header { margin-bottom: 1rem; }
		main { padding: 3rem 0 3.5rem; }
		h1 { margin-bottom: 1.6rem; }
		.sub { font-size: 1rem; line-height: 1.8; }
		.cta-row { margin-top: 2.75rem; gap: 1rem; }
		.cta, .soon { width: 100%; justify-content: center; padding: 1rem 1.4rem; }
		.cta-note { margin-top: 1.4rem; }
		footer { margin-top: 1.5rem; padding-top: 1.5rem; gap: 0.9rem 1.4rem; padding-bottom: 0.5rem; }
	}
	@media (prefers-reduced-motion: reduce) {
		header, h1, .sub, .proof-line, .ledger, .cta-row, .cta-note, footer { animation: none; }
		.soon::before { animation: none; }
	}
`;

const IMPORT_MAP = `{ "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js" } }`;

const SCENE_JS = `
import * as THREE from 'three';

const canvas = document.getElementById('scene');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

let renderer = null;
try {
	if (canvas.clientWidth > 0) {
		renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
	}
} catch (e) { /* no WebGL: the page stands on its own */ }

if (renderer) {
	renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
	const scene = new THREE.Scene();
	scene.fog = new THREE.Fog(0x15171c, 13, 30);
	const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
	camera.position.set(0, 0.4, 11);

	scene.add(new THREE.AmbientLight(0x2f343d, 1.6));
	const key = new THREE.DirectionalLight(0xffffff, 2.2);
	key.position.set(5, 7, 6);
	scene.add(key);
	const rim = new THREE.PointLight(0x3fb950, 24, 26);
	rim.position.set(-5, -2, 3);
	scene.add(rim);
	// flares up while the terminal is typing
	const typeLight = new THREE.PointLight(0x56d364, 0, 14);
	typeLight.position.set(0, 0.4, 2.2);
	scene.add(typeLight);

	// ---------------------------------------------------------------
	// The terminal screen: a 2D canvas re-drawn every frame and used
	// as a texture. A factory run types itself out on loop.
	// ---------------------------------------------------------------
	const TW = 1024, TH = 800;
	const tcv = document.createElement('canvas');
	tcv.width = TW; tcv.height = TH;
	const tctx = tcv.getContext('2d');
	const tex = new THREE.CanvasTexture(tcv);
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.anisotropy = renderer.capabilities.getMaxAnisotropy();

	const INK = '#e8eaee', GREEN = '#3fb950', BRIGHT = '#56d364';
	const DIM = 'rgba(232, 234, 238, 0.45)';
	// [text, color, ms-per-char, ms-pause-before-line]
	const SCRIPT = [
		['$ turbodiff build "session expiry"', BRIGHT, 34, 500],
		['', INK, 0, 120],
		['\\u203a planning against your code\\u2026', DIM, 10, 420],
		['\\u2713 plan approved \\u2014 4 files, 2 criteria', BRIGHT, 12, 300],
		['', INK, 0, 160],
		['\\u203a generating in sandbox\\u2026', DIM, 10, 300],
		['+ const s = await unseal(token)', GREEN, 16, 180],
		['+ if (s.exp < now()) return null', GREEN, 16, 90],
		['', INK, 0, 200],
		['\\u203a review: 1 finding \\u2192 auto-fixed', DIM, 10, 500],
		['\\u203a verifying\\u2026 app launched, screenshots', DIM, 10, 420],
		['\\u2713 2/2 criteria met', BRIGHT, 12, 420],
		['\\u2713 PR ready to merge', BRIGHT, 12, 200],
	];

	let li = 0, ci = 0, nextAt = 0, phase = 'type', phaseAt = 0, wipe = 0, lastTypeAt = -1e9;

	const step = function (t) {
		if (phase === 'type') {
			while (phase === 'type' && t >= nextAt) {
				const line = SCRIPT[li];
				if (ci < line[0].length) {
					ci++;
					lastTypeAt = t;
					nextAt = t + line[2] * (0.6 + Math.random() * 0.9);
				} else if (li + 1 < SCRIPT.length) {
					li++; ci = 0;
					nextAt = t + SCRIPT[li][3];
				} else {
					phase = 'hold'; phaseAt = t + 3200;
				}
			}
		} else if (phase === 'hold') {
			if (t >= phaseAt) { phase = 'wipe'; phaseAt = t; }
		} else {
			wipe = (t - phaseAt) / 650;
			if (wipe >= 1) { phase = 'type'; li = 0; ci = 0; wipe = 0; nextAt = t + 500; }
		}
	};

	const CHROME = 66, PADX = 46, LINE0 = 132, LH = 46;
	const dot = function (x, fill, stroke) {
		tctx.beginPath();
		tctx.arc(x, CHROME / 2, 9, 0, Math.PI * 2);
		if (fill) { tctx.fillStyle = fill; tctx.fill(); }
		if (stroke) { tctx.strokeStyle = stroke; tctx.lineWidth = 2; tctx.stroke(); }
	};

	const draw = function (t) {
		tctx.fillStyle = '#0d0f12';
		tctx.fillRect(0, 0, TW, TH);
		// chrome bar
		tctx.fillStyle = '#171a1f';
		tctx.fillRect(0, 0, TW, CHROME);
		dot(38, GREEN, null);
		dot(78, null, 'rgba(232, 234, 238, 0.7)');
		dot(118, null, 'rgba(63, 185, 80, 0.55)');
		tctx.font = '400 23px "IBM Plex Mono", ui-monospace, monospace';
		tctx.fillStyle = DIM;
		tctx.fillText('turbodiff@edge \\u2014 factory run', 156, CHROME / 2 + 8);
		tctx.fillStyle = 'rgba(63, 185, 80, 0.3)';
		tctx.fillRect(0, CHROME, TW, 2);

		// body text (slides up and fades during the wipe)
		const off = wipe * wipe * TH * 0.75;
		tctx.save();
		tctx.globalAlpha = 1 - wipe;
		tctx.font = '400 30px "IBM Plex Mono", ui-monospace, monospace';
		for (let i = 0; i <= li; i++) {
			const line = SCRIPT[i];
			const shown = i < li ? line[0] : line[0].slice(0, ci);
			tctx.fillStyle = line[1];
			tctx.fillText(shown, PADX, LINE0 + i * LH - off);
			if (i === li && phase === 'type' && (reduced || t % 1000 < 620)) {
				tctx.fillStyle = BRIGHT;
				tctx.fillRect(PADX + tctx.measureText(shown).width + 8, LINE0 + i * LH - off - 27, 16, 34);
			}
		}
		// held frame keeps a blinking cursor on a fresh prompt line
		if (phase === 'hold' && t % 1000 < 620) {
			tctx.fillStyle = BRIGHT;
			tctx.fillText('$', PADX, LINE0 + (li + 2) * LH - off);
			tctx.fillRect(PADX + 30, LINE0 + (li + 2) * LH - off - 27, 16, 34);
		}
		tctx.restore();

		// CRT scanlines
		tctx.fillStyle = 'rgba(0, 0, 0, 0.16)';
		for (let y = CHROME; y < TH; y += 4) tctx.fillRect(0, y, TW, 1);
		// glass sheen sweeping slowly across the face
		const sx = (reduced ? 0.3 : (t * 0.00006) % 1.6 - 0.3) * TW;
		const sheen = tctx.createLinearGradient(sx, 0, sx + TW * 0.55, TH);
		sheen.addColorStop(0, 'rgba(255, 255, 255, 0)');
		sheen.addColorStop(0.5, 'rgba(255, 255, 255, 0.05)');
		sheen.addColorStop(1, 'rgba(255, 255, 255, 0)');
		tctx.fillStyle = sheen;
		tctx.fillRect(0, 0, TW, TH);
		tex.needsUpdate = true;
	};

	// ---------------------------------------------------------------
	// The slab the screen lives on, plus its surroundings.
	// ---------------------------------------------------------------
	const group = new THREE.Group();
	scene.add(group);

	// glossy black body
	const body = new THREE.Mesh(
		new THREE.BoxGeometry(5.6, 4.4, 0.26),
		new THREE.MeshPhysicalMaterial({
			color: 0x101318, metalness: 0.7, roughness: 0.22,
			clearcoat: 1, clearcoatRoughness: 0.1, fog: false,
		}),
	);
	group.add(body);
	// green edge light around the slab
	const edges = new THREE.LineSegments(
		new THREE.EdgesGeometry(body.geometry),
		new THREE.LineBasicMaterial({ color: 0x3fb950, transparent: true, opacity: 0.55, fog: false }),
	);
	group.add(edges);
	// the screen face (unlit so the text stays crisp)
	const screen = new THREE.Mesh(
		new THREE.PlaneGeometry(5.25, 4.1),
		new THREE.MeshBasicMaterial({ map: tex, fog: false }),
	);
	screen.position.z = 0.135;
	group.add(screen);

	// soft green glow halo behind the slab
	const glowCv = document.createElement('canvas');
	glowCv.width = glowCv.height = 256;
	const gctx = glowCv.getContext('2d');
	const grad = gctx.createRadialGradient(128, 128, 10, 128, 128, 128);
	grad.addColorStop(0, 'rgba(63, 185, 80, 0.5)');
	grad.addColorStop(1, 'rgba(63, 185, 80, 0)');
	gctx.fillStyle = grad;
	gctx.fillRect(0, 0, 256, 256);
	const glow = new THREE.Sprite(new THREE.SpriteMaterial({
		map: new THREE.CanvasTexture(glowCv),
		blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.5,
	}));
	glow.scale.set(11, 9, 1);
	glow.position.z = -1.5;
	group.add(glow);

	// ghost terminals layered behind for depth
	const ghost = function (x, y, z, ry, opacity) {
		const g = new THREE.Group();
		const face = new THREE.Mesh(
			new THREE.PlaneGeometry(5.6, 4.4),
			new THREE.MeshBasicMaterial({ color: 0x14161b, transparent: true, opacity: opacity }),
		);
		const frame = new THREE.LineSegments(
			new THREE.EdgesGeometry(face.geometry),
			new THREE.LineBasicMaterial({ color: 0x3fb950, transparent: true, opacity: opacity * 0.7 }),
		);
		g.add(face); g.add(frame);
		g.position.set(x, y, z);
		g.rotation.y = ry;
		scene.add(g);
		return g;
	};
	ghost(-2.6, 0.9, -3.2, 0.22, 0.5);
	ghost(2.4, -0.6, -4.6, -0.28, 0.32);

	// wireframe floor scrolling toward the viewer
	const grid = new THREE.GridHelper(34, 34, 0x3fb950, 0x1c2b26);
	grid.material.transparent = true;
	grid.material.opacity = 0.4;
	grid.position.y = -3.6;
	scene.add(grid);

	// drifting green motes
	const COUNT = 160;
	const pos = new Float32Array(COUNT * 3);
	for (let i = 0; i < COUNT; i++) {
		pos[i * 3] = (Math.random() - 0.5) * 22;
		pos[i * 3 + 1] = (Math.random() - 0.5) * 12;
		pos[i * 3 + 2] = -7 + Math.random() * 9;
	}
	const dust = new THREE.BufferGeometry();
	dust.setAttribute('position', new THREE.BufferAttribute(pos, 3));
	scene.add(new THREE.Points(dust, new THREE.PointsMaterial({
		color: 0x3fb950, size: 0.035, transparent: true, opacity: 0.5,
		blending: THREE.AdditiveBlending, depthWrite: false,
	})));

	const BASE_RY = -0.3, BASE_RX = 0.04;
	group.rotation.y = BASE_RY;
	group.rotation.x = BASE_RX;
	group.position.y = 0.35;

	const fit = function () {
		const w = canvas.clientWidth, h = canvas.clientHeight;
		if (w === 0 || h === 0) return;
		renderer.setSize(w, h, false);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
	};
	fit();
	addEventListener('resize', fit);

	let mx = 0, my = 0;
	addEventListener('pointermove', function (e) {
		mx = (e.clientX / innerWidth - 0.5) * 2;
		my = (e.clientY / innerHeight - 0.5) * 2;
	});

	if (reduced) {
		// no typing loop: show the finished session, statically
		li = SCRIPT.length - 1;
		ci = SCRIPT[li][0].length;
		phase = 'hold'; phaseAt = Infinity;
	}

	const tick = function (t) {
		const time = t * 0.001;
		if (!reduced) step(t);
		draw(t);

		const sway = reduced ? 0 : Math.sin(time * 0.35) * 0.05;
		const bob = reduced ? 0 : Math.sin(time * 0.6) * 0.09;
		group.rotation.y += ((BASE_RY + sway + mx * 0.16) - group.rotation.y) * 0.04;
		group.rotation.x += ((BASE_RX + my * 0.08) - group.rotation.x) * 0.04;
		group.position.y = 0.35 + bob;
		glow.material.opacity = 0.42 + 0.1 * Math.sin(time * 1.1);
		typeLight.intensity = Math.max(0, 10 - (t - lastTypeAt) * 0.05);
		if (!reduced) grid.position.z = (time * 0.9) % 1;
		renderer.render(scene, camera);
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
}
`;

function StarIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z" />
    </svg>
  );
}

function Landing() {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Turbodiff — the software factory that built itself</title>
        <meta
          name="description"
          content="Turbodiff is an open-source software factory whose own commit history is the pitch: features planned, built, reviewed and verified by the factory itself, with screenshot proof for every acceptance criterion. Anyone can generate code. We ship proof."
        />
        <link rel="icon" type="image/png" href="/logo-small.png" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="apple-touch-icon" href="/logo.png" />
        <meta name="theme-color" content="#3fb950" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=IBM+Plex+Sans:wght@400;500&family=IBM+Plex+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <canvas id="scene" aria-hidden="true"></canvas>
        <div class="vignette" aria-hidden="true"></div>
        <div class="grain" aria-hidden="true"></div>

        <div class="frame">
          <header>
            <a class="brand" href="/">
              <img src="/logo-small.png" alt="" width="30" height="30" />
              <span class="wordmark">
                turbo<b>diff</b>
              </span>
            </a>
            <nav class="nav">
              <a href={REPO_URL}>github &rarr;</a>
            </nav>
          </header>

          <main>
            <div class="hero">
              <h1>
                Requirements in. <em>Working</em> features out.
              </h1>
              <p class="sub">
                Describe a feature and agents take it from there &mdash; planning against your real
                code, building in a sandbox, reviewing, fixing, and attaching screenshot proof for
                every acceptance criterion. You approve the plan and merge the PR. It's how
                Turbodiff builds itself.
              </p>
              <p class="proof-line">Anyone can generate code. We ship proof.</p>
              <div class="ledger" aria-label="factory ledger">
                <div class="stat">
                  <b>63%</b>
                  <span>commits written by agents</span>
                </div>
                <div class="stat">
                  <b>4 min</b>
                  <span>human time / feature</span>
                </div>
                <div class="stat">
                  <b>PR #58</b>
                  <span>last merge &middot; checks passed</span>
                </div>
              </div>
              <div class="cta-row">
                <a class="cta" href={REPO_URL}>
                  <StarIcon />
                  Star on GitHub
                </a>
                <span class="soon">coming soon</span>
              </div>
              <span class="cta-note">
                open source &middot; FSL-licensed &middot; every PR ships with receipts
              </span>
            </div>
          </main>

          <footer>
            <span>
              open source &mdash; <a href={REPO_URL}>Ngineer101/turbodiff</a>
            </span>
            <span>fully built &amp; hosted on Cloudflare</span>
            <span>self-host it &mdash; your keys, your gateway</span>
            <span>
              <a href="/auth/login">sign in</a>
            </span>
          </footer>
        </div>

        <script type="importmap" dangerouslySetInnerHTML={{ __html: IMPORT_MAP }} />
        <script type="module" dangerouslySetInnerHTML={{ __html: SCENE_JS }} />
      </body>
    </html>
  );
}

export function renderLanding(): string {
  return `<!doctype html>${(<Landing />).toString()}`;
}
