// Public HTTP "Proof of Build" certificate page, server-rendered as hono/jsx like
// landing.tsx. Pure render — no env or DB access — so it can be previewed and
// tested with fixture data outside the Worker. Data assembly lives in
// src/services/certificates.ts.
import type { CertificateData } from '../shared/certificate.ts';
import { parseUtc } from '../shared/time.ts';

const CSS = `
	:root {
		--floor: #131210;
		--paper: #ece6da;
		--ink: #1e1a16;
		--ink-soft: #6b6156;
		--accent: #ffc72c;
		--green-ink: #1f7a33;
		--green-bright: #2f9e44;
		--red-ink: #b8362c;
		--mono: "IBM Plex Mono", ui-monospace, monospace;
	}
	* { box-sizing: border-box; margin: 0; }
	body {
		min-height: 100vh;
		background: var(--floor);
		display: grid; place-items: center;
		padding: 3rem 1.5rem;
		font: 400 15px/1.5 "IBM Plex Sans", system-ui, sans-serif;
		color: var(--ink);
	}
	.grain {
		position: fixed; inset: 0; pointer-events: none; opacity: 0.9; mix-blend-mode: overlay;
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3'/%3E%3CfeColorMatrix values='0 0 0 0 0.5 0 0 0 0 0.52 0 0 0 0 0.56 0 0 0 0.3 0'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E");
	}
	.wrap { width: min(1080px, 96vw); }
	.cert {
		position: relative;
		display: grid;
		grid-template-columns: 1fr 280px;
		background:
			radial-gradient(120% 90% at 30% 0%, rgba(255,255,255,0.5), transparent 60%),
			var(--paper);
		border-radius: 6px;
		box-shadow: 8px 8px 0 var(--accent);
	}
	.cert::after {
		content: ""; position: absolute; inset: 0; border-radius: 6px; pointer-events: none;
		opacity: 0.5; mix-blend-mode: multiply;
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='p'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3CfeColorMatrix values='0 0 0 0 0.72 0 0 0 0 0.7 0 0 0 0 0.64 0 0 0 0.16 0'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23p)'/%3E%3C/svg%3E");
	}
	.main { padding: 2.2rem 2.4rem 1.9rem; min-width: 0; }
	.cert-head {
		display: flex; justify-content: space-between; align-items: flex-start; gap: 1.5rem;
		padding-bottom: 1.1rem; border-bottom: 2px solid var(--ink);
	}
	.cert-title { font-family: var(--mono); }
	.cert-title .kicker {
		font-size: 0.7rem; letter-spacing: 0.32em; text-transform: uppercase; color: var(--ink);
		font-weight: 600;
	}
	.cert-title .org {
		margin-top: 0.35rem; font-size: 0.72rem; letter-spacing: 0.08em; color: var(--ink-soft);
	}
	.cert-title .org b { color: var(--green-ink); font-weight: 600; }
	.serial { text-align: right; font-family: var(--mono); }
	.serial .label { font-size: 0.62rem; letter-spacing: 0.24em; color: var(--ink-soft); text-transform: uppercase; }
	.serial .no { font-size: 1.5rem; font-weight: 600; letter-spacing: 0.06em; margin-top: 0.1rem; }
	.barcode {
		margin-top: 0.4rem; height: 26px; width: 190px; margin-left: auto;
		background: repeating-linear-gradient(90deg,
			var(--ink) 0 2px, transparent 2px 4px, var(--ink) 4px 7px, transparent 7px 9px,
			var(--ink) 9px 10px, transparent 10px 14px, var(--ink) 14px 18px, transparent 18px 20px);
	}
	.feature { margin-top: 1.5rem; }
	.feature h1 {
		font-weight: 700;
		font-size: clamp(1.6rem, 3.2vw, 2.3rem); line-height: 1.1; letter-spacing: -0.03em;
	}
	.feature .meta {
		margin-top: 0.55rem; font-family: var(--mono); font-size: 0.76rem;
		color: var(--ink-soft); letter-spacing: 0.04em;
	}
	.feature .meta b { color: var(--ink); font-weight: 500; }
	.feature .meta a { color: var(--green-ink); text-decoration: none; font-weight: 500; }
	.feature .meta a:hover { text-decoration: underline; }
	.criteria { margin-top: 1.4rem; }
	.criteria .head {
		display: flex; justify-content: space-between; align-items: baseline;
		font-family: var(--mono); font-size: 0.66rem; letter-spacing: 0.22em;
		text-transform: uppercase; color: var(--ink-soft); margin-bottom: 0.6rem;
	}
	.criteria .head .score { color: var(--green-ink); font-weight: 600; letter-spacing: 0.1em; }
	.criteria .head .score.partial { color: var(--red-ink); }
	.criteria ul { list-style: none; padding: 0; columns: 2; column-gap: 2.2rem; }
	.criteria li {
		break-inside: avoid; display: flex; gap: 0.55rem; align-items: baseline;
		font-size: 0.83rem; line-height: 1.4; padding: 0.28rem 0;
		border-bottom: 1px dotted rgba(36, 42, 50, 0.35);
	}
	.criteria li .mark { font-family: var(--mono); font-weight: 600; color: var(--green-ink); flex: none; }
	.criteria li.fail .mark { color: var(--red-ink); }
	.criteria li.skip .mark, .criteria li.pending .mark { color: var(--ink-soft); }
	.captures { margin-top: 1.4rem; }
	.captures .head {
		font-family: var(--mono); font-size: 0.66rem; letter-spacing: 0.22em;
		text-transform: uppercase; color: var(--ink-soft); margin-bottom: 0.55rem;
	}
	.thumbs { display: flex; gap: 0.6rem; }
	.thumb {
		flex: 1; min-width: 0; aspect-ratio: 16 / 10; border: 1px solid rgba(36,42,50,0.5);
		border-radius: 3px; position: relative; overflow: hidden; background: #1b1e24;
	}
	.thumb img { width: 100%; height: 100%; object-fit: cover; object-position: top; display: block; }
	.thumb figcaption {
		position: absolute; left: 0; right: 0; bottom: 0;
		font-family: var(--mono); font-size: 0.52rem; letter-spacing: 0.12em; text-transform: uppercase;
		color: #9aa2ad; background: rgba(12, 14, 17, 0.75); padding: 0.2rem 0.4rem;
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}
	.cert-foot {
		margin-top: 1.6rem; padding-top: 0.9rem; border-top: 2px solid var(--ink);
		display: flex; justify-content: space-between; align-items: baseline; gap: 1rem;
		font-family: var(--mono); font-size: 0.72rem; color: var(--ink-soft); letter-spacing: 0.05em;
	}
	.cert-foot .tagline { font-weight: 700; font-size: 0.95rem; color: var(--ink); letter-spacing: -0.01em; }
	.cert-foot a { color: var(--green-ink); text-decoration: none; font-weight: 600; }
	.stub {
		position: relative;
		border-left: 2px dashed rgba(36, 42, 50, 0.5);
		padding: 2rem 1.6rem 1.9rem;
		display: flex; flex-direction: column;
		background: linear-gradient(180deg, rgba(31, 122, 51, 0.06), transparent 40%);
	}
	.stub::before, .stub::after {
		content: ""; position: absolute; left: -13px; width: 24px; height: 24px; border-radius: 50%;
		background: var(--floor);
	}
	.stub::before { top: -12px; }
	.stub::after { bottom: -12px; }
	.punch {
		position: absolute; top: 1.35rem; right: 1.35rem; width: 22px; height: 22px; border-radius: 50%;
		background: var(--floor);
		box-shadow: inset 0 1px 2px rgba(0,0,0,0.7), 0 1px 0 rgba(255,255,255,0.5);
	}
	.stub .head {
		font-family: var(--mono); font-size: 0.62rem; letter-spacing: 0.28em;
		text-transform: uppercase; color: var(--ink-soft);
	}
	.gauges { margin-top: 1.1rem; display: grid; gap: 0.85rem; }
	.gauge { font-family: var(--mono); border-left: 3px solid var(--accent); padding-left: 0.7rem; }
	.gauge b { display: block; font-size: 1.25rem; font-weight: 600; letter-spacing: 0.02em; }
	.gauge span { font-size: 0.6rem; letter-spacing: 0.18em; text-transform: uppercase; color: var(--ink-soft); }
	.stamp-zone { margin-top: auto; padding-top: 1.4rem; display: grid; place-items: center; }
	.stamp {
		--sink: var(--green-bright);
		transform: rotate(-8deg);
		border: 3px double var(--sink); border-radius: 10px;
		padding: 0.55rem 1.1rem 0.65rem; text-align: center;
		color: var(--sink);
		font-family: var(--mono); text-transform: uppercase;
		mix-blend-mode: multiply; opacity: 0.9;
		mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='r'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.11' numOctaves='3'/%3E%3CfeColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.92 0.05'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23r)'/%3E%3C/svg%3E");
		mask-size: 120px;
	}
	.stamp.pending { --sink: var(--ink-soft); transform: rotate(-4deg); }
	.stamp .big { font-size: 1.55rem; font-weight: 600; letter-spacing: 0.14em; line-height: 1.1; }
	.stamp .sub { font-size: 0.58rem; letter-spacing: 0.3em; margin-top: 0.25rem; }
	.stamp .date { font-size: 0.66rem; letter-spacing: 0.14em; margin-top: 0.35rem; border-top: 1px solid var(--sink); padding-top: 0.3rem; }
	.stub .sig { margin-top: 1.3rem; font-family: var(--mono); font-size: 0.6rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-soft); }
	.stub .sig .line { font-weight: 600; font-size: 0.95rem; color: var(--ink); text-transform: none; letter-spacing: -0.01em; border-bottom: 1px solid var(--ink); padding-bottom: 0.15rem; margin-bottom: 0.3rem; }
	.colophon {
		margin-top: 1.1rem; text-align: center;
		font-family: var(--mono); font-size: 0.7rem; letter-spacing: 0.08em; color: #9b948a;
	}
	.colophon a { color: var(--accent); text-decoration: none; }
	.colophon a:hover { text-decoration: underline; }
	@media (max-width: 860px) {
		.cert { grid-template-columns: 1fr; }
		.stub { border-left: 0; border-top: 2px dashed rgba(36,42,50,0.5); }
		.stub::before { top: -12px; left: -12px; }
		.stub::after { top: -12px; left: auto; right: -12px; bottom: auto; }
		.criteria ul { columns: 1; }
		.thumbs { flex-wrap: wrap; }
		.thumb { flex: 1 1 45%; }
	}
`;

const MARK = { pass: '✓', fail: '✗', skip: '–' };

// e.g. "12 Aug 2026" from an ISO/SQLite timestamp; falls back to the raw string.
function fmtDate(iso: string): string {
  const d = new Date(parseUtc(iso));
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function stampDate(iso: string): string {
  const d = new Date(parseUtc(iso));
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())} · ${pad(d.getUTCMonth() + 1)} · ${d.getUTCFullYear()}`;
}

function Certificate({ data }: { data: CertificateData }) {
  const passed = data.criteria.filter((c) => c.verdict === 'pass').length;
  const total = data.criteria.length;
  const description = data.verified
    ? `${passed}/${total} acceptance criteria verified with screenshot proof by the Turbodiff software factory.`
    : `Built by the Turbodiff software factory — ${passed}/${total} acceptance criteria verified so far.`;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`Proof of Build — ${data.featureTitle}`}</title>
        <meta name="description" content={description} />
        <meta name="robots" content="noindex" />
        <meta property="og:type" content="website" />
        <meta property="og:title" content={`Proof of Build — ${data.featureTitle}`} />
        <meta property="og:description" content={description} />
        <meta property="og:url" content={data.pageUrl} />
        {data.screenshots[0] ? (
          <>
            <meta property="og:image" content={data.screenshots[0].url} />
            <meta name="twitter:card" content="summary_large_image" />
          </>
        ) : null}
        <link rel="icon" type="image/png" href="/logo-small.png" />
        <link href="/fonts/fonts.css" rel="stylesheet" />
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <div class="grain" aria-hidden="true"></div>
        <div class="wrap">
          <article class="cert">
            <div class="main">
              <header class="cert-head">
                <div class="cert-title">
                  <div class="kicker">Proof of Build</div>
                  <div class="org">
                    issued by <b>turbodiff</b> autonomous software factory
                  </div>
                </div>
                <div class="serial">
                  <div class="label">Build No.</div>
                  <div class="no">{data.serial}</div>
                  <div class="barcode" aria-hidden="true"></div>
                </div>
              </header>

              <section class="feature">
                <h1>{data.featureTitle}</h1>
                <p class="meta">
                  <b>{data.repoFullName}</b> &middot; <a href={data.prUrl}>PR #{data.prNumber}</a>
                  {data.verifiedAt ? <> &middot; verified {fmtDate(data.verifiedAt)}</> : null}
                </p>
              </section>

              {total > 0 ? (
                <section class="criteria">
                  <div class="head">
                    <span>Acceptance criteria — verified</span>
                    <span class={passed === total ? 'score' : 'score partial'}>
                      {passed} / {total} passed
                    </span>
                  </div>
                  <ul>
                    {data.criteria.map((c) => (
                      <li class={c.verdict ?? 'pending'}>
                        <span class="mark">{c.verdict ? MARK[c.verdict] : '·'}</span>
                        {c.text}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {data.screenshots.length > 0 ? (
                <section class="captures">
                  <div class="head">Screenshot proof — {data.screenshotCount} attached</div>
                  <div class="thumbs">
                    {data.screenshots.map((s) => (
                      <figure class="thumb">
                        <img src={s.url} alt={s.label} loading="lazy" />
                        <figcaption>{s.label}</figcaption>
                      </figure>
                    ))}
                  </div>
                </section>
              ) : null}

              <footer class="cert-foot">
                <span class="tagline">Anyone can generate code. We ship proof.</span>
                <span>
                  built by <a href="https://turbodiff.dev">turbodiff.dev</a>
                </span>
              </footer>
            </div>

            <aside class="stub">
              <span class="punch" aria-hidden="true"></span>
              <div class="head">Build stats</div>
              <div class="gauges">
                {data.agentMinutes !== null ? (
                  <div class="gauge">
                    <b>{data.agentMinutes} min</b>
                    <span>agent time</span>
                  </div>
                ) : null}
                <div class="gauge">
                  <b>{data.agentRuns}</b>
                  <span>agent runs</span>
                </div>
                <div class="gauge">
                  <b>{data.fixIterations}</b>
                  <span>fix iterations</span>
                </div>
                <div class="gauge">
                  <b>{data.screenshotCount}</b>
                  <span>screenshots</span>
                </div>
              </div>
              <div class="stamp-zone">
                {data.verified ? (
                  <div class="stamp">
                    <div class="big">Verified</div>
                    <div class="sub">All checks passed</div>
                    {data.verifiedAt ? <div class="date">{stampDate(data.verifiedAt)}</div> : null}
                  </div>
                ) : (
                  <div class="stamp pending">
                    <div class="big">In progress</div>
                    <div class="sub">Verification pending</div>
                  </div>
                )}
              </div>
              {data.authorLogin ? (
                <div class="sig">
                  <div class="line">{data.authorLogin}</div>
                  approved &amp; merged by
                </div>
              ) : null}
            </aside>
          </article>
          <p class="colophon">
            This certificate is generated from the factory&apos;s own verification run — the
            receipts are real. <a href="https://turbodiff.dev">Get your own factory &rarr;</a>
          </p>
        </div>
      </body>
    </html>
  );
}

export function renderCertificatePage(data: CertificateData): string {
  return `<!doctype html>${(<Certificate data={data} />).toString()}`;
}
