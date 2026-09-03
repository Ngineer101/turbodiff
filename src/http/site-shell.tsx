// Shell shared by the signed-out HTTP pages (landing.tsx, blog.tsx): the
// Signage tokens, the reset, the sticker vocabulary, and the site header and
// footer. Each page appends its own CSS after SHELL_CSS. The Paper file is
// the source of truth for the design:
// https://app.paper.design/file/01M1H1H5D09QPHCSFA3X0727EN

export const REPO_URL = 'https://github.com/Ngineer101/turbodiff';
export const SITE_URL = 'https://turbodiff.dev';

export const SHELL_CSS = `
	:root {
		--bg: #131210;
		--surface: #1c1a17;
		--surface-2: #0f0e0c;
		--raised: #24211d;
		--line: #2a2722;
		--line-2: #3a362f;
		--ink: #ece6da;
		--ink-dim: #c9c2b6;
		--mute: #9b948a;
		--accent: #ffc72c;
		--accent-bright: #ffd45c;
		--accent-ink: #131210;
		--go: #3fb950;
		--go-bright: #56d364;
		--danger: #ff6b57;
		--mono: "IBM Plex Mono", ui-monospace, monospace;
		--sans: "IBM Plex Sans", system-ui, sans-serif;
		--ease: cubic-bezier(0.2, 0.7, 0.2, 1);
	}
	* { box-sizing: border-box; margin: 0; }
	html { scroll-behavior: smooth; }
	body {
		background: var(--bg);
		color: var(--ink);
		font: 400 15px/1.6 var(--sans);
		-webkit-font-smoothing: antialiased;
	}
	a { color: inherit; text-decoration: none; }
	.wrap { width: min(100% - 2.5rem, 1312px); margin: 0 auto; }

	/* --- stickers: the shared vocabulary --- */
	.tag {
		display: inline-block;
		padding: 0.3em 0.75em; border-radius: 4px;
		background: var(--accent); color: var(--accent-ink);
		font-family: var(--mono); font-size: 0.66rem; font-weight: 700;
		letter-spacing: 0.18em; text-transform: uppercase;
		box-shadow: 2px 2px 0 var(--ink);
		transform: rotate(-3deg);
	}
	.tag.flat { transform: rotate(-2deg); box-shadow: none; }
	.mark {
		display: block; width: 34px; height: 34px; border-radius: 7px;
		box-shadow: 3px 3px 0 var(--accent);
		transform: rotate(-6deg);
	}
	.card {
		background: var(--surface); border: 1px solid var(--line-2); border-radius: 10px;
		box-shadow: 3px 3px 0 var(--line);
	}
	.card.live { border-color: var(--accent); box-shadow: 3px 3px 0 var(--accent); }
	.lamp {
		display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
	}
	.lamp.go { background: var(--go); box-shadow: 0 0 9px 2px rgba(63, 185, 80, 0.45); }
	.lamp.hold { background: var(--accent); box-shadow: 0 0 9px 2px rgba(255, 199, 44, 0.45); }
	.lamp.off { background: #4a463f; }
	.lamp.pulse { animation: pulse 1.6s ease-in-out infinite; }
	@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
	.placard {
		display: inline-flex; align-items: center; gap: 0.6em;
		font-family: var(--mono); font-size: 0.68rem; font-weight: 600;
		letter-spacing: 0.18em; text-transform: uppercase; color: var(--ink);
	}
	.placard.hot { color: var(--accent); }

	/* --- header --- */
	header {
		border-bottom: 1px solid var(--line);
	}
	header .wrap {
		display: flex; align-items: center; justify-content: space-between;
		padding: 1.5rem 0;
	}
	.brand { display: flex; align-items: center; gap: 0.75rem; }
	.wordmark { font-weight: 700; font-size: 1.35rem; letter-spacing: -0.02em; color: var(--ink); }
	.nav { display: flex; align-items: center; gap: 1.75rem; font-family: var(--mono); font-size: 0.78rem; letter-spacing: 0.08em; color: var(--mute); }
	.nav a { transition: color 0.15s; }
	.nav a:hover { color: var(--ink); }
	.nav .repo {
		padding: 0.5rem 0.9rem; border-radius: 6px; border: 1.5px solid var(--line-2); color: var(--ink);
		transition: border-color 0.15s, background 0.15s;
	}
	.nav .repo:hover { border-color: var(--accent); background: var(--raised); }
	@media (max-width: 720px) { .nav a:not(.repo) { display: none; } }

	/* --- footer --- */
	footer { border-top: 1px solid var(--line); }
	footer .wrap {
		display: flex; gap: 2rem; flex-wrap: wrap; justify-content: space-between;
		padding: 1.6rem 0; font-family: var(--mono); font-size: 0.72rem; letter-spacing: 0.06em; color: var(--mute);
	}
	footer a { border-bottom: 1px solid var(--line-2); transition: color 0.15s, border-color 0.15s; }
	footer a:hover { color: var(--ink); border-color: var(--accent); }
	@media (max-width: 600px) {
		footer .wrap { flex-direction: column; gap: 0.7rem; }
	}
`;

// Section anchors are absolute so the header works from any page, not only /.
// No sign-in link until launch: the GitHub link takes the outlined slot and is
// the one item that stays visible on small screens.
export function SiteHeader() {
  return (
    <header>
      <div class="wrap">
        <a class="brand" href="/">
          <img class="mark" src="/logo-small.png" alt="" width="34" height="34" />
          <span class="wordmark">turbodiff</span>
        </a>
        <nav class="nav">
          <a href="/#how">how it works</a>
          <a href="/#proof">proof</a>
          <a class="repo" href={REPO_URL}>
            github &rarr;
          </a>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer>
      <div class="wrap">
        <span>
          open source &mdash; <a href={REPO_URL}>Ngineer101/turbodiff</a> &middot; FSL-licensed
        </span>
        <span>fully built &amp; hosted on Cloudflare</span>
        <span>self-host it &mdash; your keys, your gateway</span>
      </div>
    </footer>
  );
}
