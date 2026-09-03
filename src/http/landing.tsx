// Signed-out HTTP landing page, server-rendered as a hono/jsx component (React
// syntax, stringified in the Worker — no client-side React bundle).
//
// Signage direction: warm graphite ground, bone text, chrome yellow as the one
// working colour, phosphor green only for GO. Depth is hard-offset sticker
// shadows. The hero object is a terminal "sticker card" that drops onto the
// page with CSS keyframes and then types a factory run out with one timer —
// no canvas, no WebGL, no third-party script. The Paper file is the source of
// truth for the design: https://app.paper.design/file/01M1H1H5D09QPHCSFA3X0727EN
//
// The header, footer and shared tokens live in site-shell.tsx.
//
// CSS and the client script are kept as plain strings injected with
// dangerouslySetInnerHTML so JSX text escaping can't mangle them. The script
// string must not contain backticks or `${` sequences.

import { SHELL_CSS, REPO_URL, SiteFooter, SiteHeader } from './site-shell.tsx';

const CSS = `
	/* --- hero --- */
	.hero .wrap {
		display: grid; grid-template-columns: minmax(0, 620px) minmax(0, 1fr);
		gap: 3.5rem; align-items: center;
		padding: clamp(3rem, 7vw, 5.5rem) 0 clamp(2.5rem, 5vw, 4.5rem);
	}
	.hero-copy { display: flex; flex-direction: column; align-items: flex-start; gap: 1.5rem; }
	.hero-copy > * { animation: rise 0.7s var(--ease) both; }
	.hero-copy > :nth-child(2) { animation-delay: 0.08s; }
	.hero-copy > :nth-child(3) { animation-delay: 0.16s; }
	.hero-copy > :nth-child(4) { animation-delay: 0.24s; }
	.hero-copy > :nth-child(5) { animation-delay: 0.32s; }
	h1 {
		font-weight: 700; letter-spacing: -0.035em; line-height: 1.02;
		font-size: clamp(2.05rem, 5.2vw, 3.9rem); color: var(--ink);
	}
	.sub { color: var(--ink-dim); font-size: clamp(1rem, 1.3vw, 1.125rem); line-height: 1.6; max-width: 32rem; }
	.cta-row { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; padding-top: 0.25rem; }
	.cta {
		display: inline-flex; align-items: center; gap: 0.55em;
		padding: 0.8rem 1.4rem; border-radius: 8px;
		background: var(--accent); color: var(--accent-ink);
		font-weight: 700; font-size: 0.95rem;
		box-shadow: 4px 4px 0 var(--ink);
		transition: transform 0.12s ease-out, box-shadow 0.12s ease-out, background 0.12s;
	}
	.cta:hover { background: var(--accent-bright); transform: translate(-1px, -1px); box-shadow: 5px 5px 0 var(--ink); }
	.cta:active { transform: translate(2px, 2px); box-shadow: 1px 1px 0 var(--ink); }
	.cta svg { width: 1em; height: 1em; fill: currentColor; }
	.read {
		display: inline-flex; align-items: center; gap: 0.6em;
		font-family: var(--mono); font-size: 0.78rem; letter-spacing: 0.08em;
		color: var(--ink); padding: 0 1.2rem; border-radius: 8px; align-self: stretch;
		border: 1.5px solid var(--line-2);
		transition: border-color 0.15s, color 0.15s;
	}
	.read:hover { border-color: var(--accent); color: var(--accent); }
	.cta-note { font-family: var(--mono); color: var(--mute); font-size: 0.72rem; letter-spacing: 0.08em; }

	/* --- the terminal sticker --- */
	.term {
		position: relative;
		border-radius: 12px; overflow: hidden;
		background: var(--surface); border: 1.5px solid var(--line-2);
		box-shadow: 8px 8px 0 var(--accent);
		transform: rotate(1deg);
		font-family: var(--mono);
	}
	.term .chrome {
		display: flex; align-items: center; gap: 0.6rem;
		padding: 0.75rem 1rem; border-bottom: 1px solid var(--line); background: var(--surface-2);
		font-size: 0.7rem; letter-spacing: 0.06em; color: var(--mute);
	}
	.term .dot { width: 10px; height: 10px; border-radius: 50%; }
	.term .dot.g { background: var(--go); }
	.term .dot.y { background: var(--accent); }
	.term .dot.r { background: var(--danger); }
	.term .chrome span:last-child { padding-left: 0.25rem; }
	.term pre {
		margin: 0; padding: 1.25rem 1.4rem 1.5rem;
		font: inherit; font-size: clamp(0.8rem, 1vw, 0.92rem); line-height: 1.8;
		color: var(--ink); white-space: pre; overflow: hidden;
		min-height: 15.5em;
	}
	.term .ln { display: block; min-height: 1.8em; }
	.term .ln.dim { color: var(--ink-dim); }
	.term .ln.go { color: var(--go-bright); }
	.term .cursor {
		display: inline-block; width: 0.55em; height: 1.05em; vertical-align: -0.15em;
		background: var(--accent); margin-left: 0.1em;
	}
	.term .cursor.blink { animation: blink 1.1s step-end infinite; }
	@keyframes blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
	/* the drop: hidden → settled, then the shadow catches up and the card tilts */
	.term.boot {
		animation: drop 0.22s var(--ease) both, land 0.18s 0.22s var(--ease) both;
	}
	@keyframes drop {
		from { opacity: 0; transform: translateY(12px) scale(0.94) rotate(0deg); box-shadow: 0 0 0 var(--accent); }
		to { opacity: 1; transform: translateY(0) scale(1) rotate(0deg); box-shadow: 0 0 0 var(--accent); }
	}
	@keyframes land {
		from { transform: rotate(0deg); box-shadow: 0 0 0 var(--accent); }
		to { transform: rotate(1deg); box-shadow: 8px 8px 0 var(--accent); }
	}
	@media (max-width: 899px) {
		.hero .wrap { grid-template-columns: 1fr; gap: 2.5rem; }
		.term, .term.boot { transform: none; box-shadow: 6px 6px 0 var(--accent); }
		@keyframes land { from { box-shadow: 0 0 0 var(--accent); } to { box-shadow: 6px 6px 0 var(--accent); } }
	}

	/* --- proof strip --- */
	.proof { border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); background: var(--surface-2); }
	.proof .wrap { padding: 3.25rem 0; display: flex; flex-direction: column; gap: 1.75rem; }
	.proof .head { display: flex; align-items: flex-end; justify-content: space-between; gap: 2rem; }
	h2 { font-weight: 700; letter-spacing: -0.03em; line-height: 1.08; font-size: clamp(1.7rem, 3vw, 2.5rem); }
	.lede { color: var(--mute); max-width: 26rem; font-size: 0.95rem; }
	.tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1.25rem; }
	.tile { padding: 1.25rem 1.4rem; display: flex; flex-direction: column; gap: 0.35rem; }
	.tile .label { font-family: var(--mono); font-size: 0.64rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--mute); display: flex; align-items: center; gap: 0.5em; }
	.tile .label.go { color: var(--go); }
	.tile b { font-family: var(--mono); font-weight: 600; font-size: clamp(1.9rem, 3vw, 2.5rem); line-height: 1.1; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
	.tile b.hot { color: var(--accent); }
	.tile .sub-line { font-size: 0.78rem; color: var(--mute); }

	/* --- how it works --- */
	.how .wrap { padding: clamp(3rem, 6vw, 5.5rem) 0; display: flex; flex-direction: column; gap: 2rem; }
	.how .head { display: flex; align-items: flex-end; justify-content: space-between; gap: 2rem; }
	.how .head > div { display: flex; flex-direction: column; align-items: flex-start; gap: 0.8rem; }
	.stages { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1.25rem; }
	.stage { padding: 1.5rem; display: flex; flex-direction: column; gap: 0.9rem; }
	.stage .top { display: flex; align-items: center; justify-content: space-between; }
	.stage .n { font-family: var(--mono); font-size: 1.6rem; font-weight: 600; color: var(--line-2); }
	.stage p { font-size: 0.95rem; line-height: 1.5; color: var(--ink-dim); }
	.stage .who {
		align-self: flex-start; margin-top: auto;
		padding: 0.35rem 0.6rem; border-radius: 4px;
		background: var(--bg); border: 1px solid var(--line-2);
		font-family: var(--mono); font-size: 0.68rem; color: var(--mute);
	}
	.stage .who.you { color: var(--accent); }

	/* --- certificate --- */
	.cert { border-top: 1px solid var(--line); }
	.cert .wrap {
		display: grid; grid-template-columns: minmax(0, 440px) minmax(0, 1fr); gap: 4rem; align-items: center;
		padding: clamp(3rem, 6vw, 5rem) 0 clamp(3.5rem, 7vw, 6rem);
	}
	.cert-copy { display: flex; flex-direction: column; align-items: flex-start; gap: 1.2rem; }
	.cert-copy p { color: var(--ink-dim); line-height: 1.6; }
	.ghost {
		display: inline-flex; align-items: center; gap: 0.5em;
		padding: 0.7rem 1.2rem; border-radius: 8px; border: 1.5px solid var(--accent);
		color: var(--accent); font-weight: 700; font-size: 0.9rem;
		transition: background 0.15s;
	}
	.ghost:hover { background: rgba(255, 199, 44, 0.1); }
	.certificate {
		padding: 1.75rem; display: flex; flex-direction: column; gap: 1.1rem;
		border-radius: 12px; border-width: 1.5px; box-shadow: 8px 8px 0 var(--line);
		transform: rotate(-1deg);
	}
	.certificate .top { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
	.certificate .meta { font-family: var(--mono); font-size: 0.66rem; letter-spacing: 0.16em; text-transform: uppercase; color: var(--mute); }
	.certificate h3 { font-weight: 700; font-size: 1.35rem; letter-spacing: -0.02em; line-height: 1.25; margin: 0.3rem 0 0.35rem; }
	.certificate .sha { font-family: var(--mono); font-size: 0.72rem; color: var(--mute); }
	.seal {
		flex-shrink: 0;
		padding: 0.35em 0.8em; border-radius: 5px;
		background: var(--accent); color: var(--accent-ink);
		font-family: var(--mono); font-size: 0.8rem; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase;
		box-shadow: 3px 3px 0 var(--ink); transform: rotate(-8deg);
	}
	.criteria { padding: 0.9rem; border-radius: 8px; background: var(--bg); border: 1px solid var(--line-2); display: flex; flex-direction: column; gap: 0.55rem; }
	.criteria .meta { font-size: 0.6rem; }
	.criteria li { list-style: none; display: flex; align-items: center; gap: 0.65rem; font-size: 0.88rem; }
	.criteria .ok {
		display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
		width: 18px; height: 18px; border-radius: 50%; background: var(--go); color: #04140a;
		font-size: 0.6rem; font-weight: 700;
	}
	.criteria .shot { margin-left: auto; width: 52px; height: 32px; border-radius: 4px; background: var(--line); border: 1px solid var(--line-2); flex-shrink: 0; }
	.ledger { display: flex; gap: 1.5rem; flex-wrap: wrap; padding-top: 0.8rem; border-top: 1px solid var(--line-2); font-family: var(--mono); font-size: 0.72rem; }
	.ledger div { display: flex; flex-direction: column; gap: 0.15rem; }
	.ledger em { font-style: normal; }
	.ledger span { font-size: 0.56rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--mute); }
	.ledger .go { color: var(--go-bright); }
	.ledger .hot { color: var(--accent); }

	@keyframes rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
	@media (max-width: 899px) {
		.tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
		.stages { grid-template-columns: repeat(2, minmax(0, 1fr)); }
		.cert .wrap { grid-template-columns: 1fr; gap: 2rem; }
		.certificate { transform: none; box-shadow: 6px 6px 0 var(--line); }
		.proof .head, .how .head { flex-direction: column; align-items: flex-start; gap: 0.8rem; }
	}
	@media (max-width: 600px) {
		.tiles, .stages { grid-template-columns: 1fr; }
		.cta { width: 100%; justify-content: center; padding: 0.95rem 1.4rem; }
		.criteria .shot { display: none; }
	}
	@media (prefers-reduced-motion: reduce) {
		.hero-copy > *, .term.boot { animation: none; }
		.lamp.pulse, .term .cursor.blink { animation: none; }
		.cta, .cta:hover, .cta:active { transform: none; }
	}
`;

// The boot: a CSS drop on the card, then one interval that types the factory
// run into the <pre>. [text, class, ms-per-char, hold-after-ms]. Reduced
// motion skips straight to the held frame.
const BOOT_JS = `
(function () {
	var pre = document.getElementById('term-body');
	var card = document.getElementById('term');
	if (!pre || !card) return;
	var SCRIPT = [
		['$ turbodiff build "session expiry"', 'ln', 34, 500],
		['\\u203a planning against your code\\u2026', 'ln dim', 10, 360],
		['\\u2713 plan approved \\u2014 4 files, 2 criteria', 'ln', 12, 260],
		['+ if (s.exp < now()) return null', 'ln go', 16, 220],
		['\\u203a review: 1 finding \\u2192 auto-fixed', 'ln dim', 10, 360],
		['\\u2713 verifying\\u2026 app launched, screenshots', 'ln dim', 10, 340],
		['\\u2713 2/2 criteria met', 'ln', 12, 360],
		['\\u2713 PR ready to merge', 'ln', 12, 200]
	];
	function esc(s) {
		return s.replace(/[&<>]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]; });
	}
	function render(li, ci, done) {
		var html = '';
		for (var i = 0; i < SCRIPT.length; i++) {
			if (i > li) break;
			var line = SCRIPT[i];
			var shown = i < li ? line[0] : line[0].slice(0, ci);
			var cursor = i === li && !done ? '<span class="cursor"></span>' : '';
			html += '<span class="' + line[1] + '">' + esc(shown) + cursor + '</span>';
		}
		if (done) html += '<span class="ln">$ <span class="cursor blink"></span></span>';
		pre.innerHTML = html;
	}
	var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
	if (reduced) {
		render(SCRIPT.length - 1, SCRIPT[SCRIPT.length - 1][0].length, true);
		return;
	}
	card.className += ' boot';
	// Wall-clock driven so a throttled tab catches up in a burst instead of
	// typing in slow motion; every due character is processed per tick.
	var li = 0, ci = 0, nextAt = 400, start = performance.now();
	render(0, 0, false);
	var timer = setInterval(function () {
		var t = performance.now() - start;
		var changed = false;
		while (t >= nextAt) {
			var line = SCRIPT[li];
			if (ci < line[0].length) {
				ci++;
				nextAt += line[2];
			} else if (li + 1 < SCRIPT.length) {
				nextAt += line[3];
				li++; ci = 0;
			} else {
				clearInterval(timer);
				render(li, ci, true);
				return;
			}
			changed = true;
		}
		if (changed) render(li, ci, false);
	}, 33);
})();
`;

function StarIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z" />
    </svg>
  );
}

// The four lights. Copy is engineer-native: PR, checks, plan, acceptance
// criteria, screenshot proof, receipts — never work orders, units, or shifts.
const STAGES = [
  {
    n: '01',
    label: 'Plan',
    lamp: 'go',
    body: 'Agents read your real repo, not a summary, and write a plan with files, acceptance criteria and risks.',
    who: 'you approve →',
    you: true,
  },
  {
    n: '02',
    label: 'Build',
    lamp: 'hold',
    body: 'A sandbox on the edge checks out a branch, implements the plan, runs your checks, and opens the PR.',
    who: 'agents work',
    you: false,
  },
  {
    n: '03',
    label: 'Verify',
    lamp: 'off',
    body: 'A reviewer agent reads the diff and fixes what it finds. Then the app is launched and every criterion gets a screenshot.',
    who: 'proof attached',
    you: false,
  },
  {
    n: '04',
    label: 'Ship',
    lamp: 'off',
    body: 'You read the receipts and merge. The feature earns a certificate with its serial, checks, and screenshots.',
    who: 'you merge →',
    you: true,
  },
] as const;

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
        <meta name="theme-color" content="#ffc72c" />
        <link href="/fonts/fonts.css" rel="stylesheet" />
        <style dangerouslySetInnerHTML={{ __html: SHELL_CSS + CSS }} />
      </head>
      <body>
        <SiteHeader />

        <main>
          <section class="hero">
            <div class="wrap">
              <div class="hero-copy">
                <span class="tag">the software factory that builds itself</span>
                <h1>
                  Requirements in.
                  <br />
                  Working features out.
                </h1>
                <p class="sub">
                  Describe a feature. Agents plan against your real code, build, review, fix, and
                  attach screenshot proof for every acceptance criterion. You approve the plan and
                  merge the PR. It's how Turbodiff builds itself.
                </p>
                <div class="cta-row">
                  <a class="cta" href={REPO_URL}>
                    <StarIcon />
                    Star on GitHub
                  </a>
                  <a class="read" href="/blog/why-i-built-this">
                    read: why I built this &rarr;
                  </a>
                </div>
                <span class="cta-note">
                  Anyone can generate code. We ship proof. &middot; open source &middot;
                  FSL-licensed
                </span>
              </div>

              <div class="term" id="term" aria-hidden="true">
                <div class="chrome">
                  <span class="dot g"></span>
                  <span class="dot y"></span>
                  <span class="dot r"></span>
                  <span>turbodiff@edge &mdash; factory run</span>
                </div>
                <pre id="term-body">
                  <span class="ln">$ turbodiff build "session expiry"</span>
                  <span class="ln dim">&rsaquo; planning against your code&hellip;</span>
                  <span class="ln">&#10003; plan approved &mdash; 4 files, 2 criteria</span>
                  <span class="ln go">+ if (s.exp &lt; now()) return null</span>
                  <span class="ln dim">&rsaquo; review: 1 finding &rarr; auto-fixed</span>
                  <span class="ln dim">&#10003; verifying&hellip; app launched, screenshots</span>
                  <span class="ln">&#10003; 2/2 criteria met</span>
                  <span class="ln">&#10003; PR ready to merge</span>
                  <span class="ln">$ </span>
                </pre>
              </div>
            </div>
          </section>

          <section class="proof" id="proof">
            <div class="wrap">
              <div class="head">
                <h2>
                  Anyone can generate code.
                  <br />
                  We ship proof.
                </h2>
                <p class="lede">
                  Turbodiff's own commit history is the pitch. Every merged feature carries its
                  plan, its checks, and a screenshot per acceptance criterion.
                </p>
              </div>
              <div class="tiles" aria-label="factory ledger">
                <div class="card tile">
                  <span class="label">commits written by agents</span>
                  <b class="hot">63%</b>
                  <span class="sub-line">of the commits on main</span>
                </div>
                <div class="card tile">
                  <span class="label">human time per feature</span>
                  <b>4 min</b>
                  <span class="sub-line">read the plan, review the proof, merge</span>
                </div>
                <div class="card tile">
                  <span class="label go">
                    <span class="lamp go" aria-hidden="true"></span>
                    last merge
                  </span>
                  <b>PR #58</b>
                  <span class="sub-line">checks passed &middot; receipts attached</span>
                </div>
              </div>
            </div>
          </section>

          <section class="how" id="how">
            <div class="wrap">
              <div class="head">
                <div>
                  <span class="tag flat">how it works</span>
                  <h2>Four lights. One PR.</h2>
                </div>
                <p class="lede">
                  Every task on the board shows where it is at a glance. The same four stages run on
                  every feature, and you step in twice: to approve the plan, and to merge.
                </p>
              </div>
              <div class="stages">
                {STAGES.map((s) => (
                  <div key={s.n} class={s.lamp === 'hold' ? 'card stage live' : 'card stage'}>
                    <div class="top">
                      <span class={s.lamp === 'hold' ? 'placard hot' : 'placard'}>
                        <span class={`lamp ${s.lamp}`} aria-hidden="true"></span>
                        {s.label}
                      </span>
                      <span class="n">{s.n}</span>
                    </div>
                    <p>{s.body}</p>
                    <span class={s.you ? 'who you' : 'who'}>{s.who}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section class="cert">
            <div class="wrap">
              <div class="cert-copy">
                <span class="tag flat">proof of build</span>
                <h2>Every merged feature earns a certificate.</h2>
                <p>
                  Serial, plan, diff, checks, and a screenshot for each acceptance criterion, sealed
                  at merge time. Share the link instead of explaining what shipped.
                </p>
                <a class="ghost" href={REPO_URL}>
                  See how it's built &rarr;
                </a>
              </div>
              <div class="card certificate" aria-label="example proof of build">
                <div class="top">
                  <div>
                    <div class="meta">proof of build &middot; TD-0130</div>
                    <h3>Fix PNG previews in the chat rail</h3>
                    <div class="sha">Ngineer101/turbodiff &middot; merged 3f63d45</div>
                  </div>
                  <span class="seal">shipped</span>
                </div>
                <ul class="criteria">
                  <li class="meta">acceptance criteria</li>
                  <li>
                    <span class="ok">&#10003;</span>
                    PNG attachments render inline at their natural size
                    <span class="shot" aria-hidden="true"></span>
                  </li>
                  <li>
                    <span class="ok">&#10003;</span>
                    Broken images show the filename, never a blank box
                    <span class="shot" aria-hidden="true"></span>
                  </li>
                  <li>
                    <span class="ok">&#10003;</span>
                    Mobile rail does not overflow with a wide image
                    <span class="shot" aria-hidden="true"></span>
                  </li>
                </ul>
                <div class="ledger">
                  <div>
                    <span>checks</span>
                    <em class="go">14 / 14</em>
                  </div>
                  <div>
                    <span>diff</span>
                    <em>+212 &minus;48 &middot; 6 files</em>
                  </div>
                  <div>
                    <span>review</span>
                    <em>1 finding, fixed</em>
                  </div>
                  <div>
                    <span>human time</span>
                    <em class="hot">4 min</em>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </main>

        <SiteFooter />

        <script dangerouslySetInnerHTML={{ __html: BOOT_JS }} />
      </body>
    </html>
  );
}

export function renderLanding(): string {
  return `<!doctype html>${(<Landing />).toString()}`;
}
