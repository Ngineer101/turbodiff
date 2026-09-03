// Public long-form pages (blog posts, and later docs), server-rendered as
// hono/jsx like landing.tsx. One reading column at 720px with a table of
// contents rail on the left and a share rail on the right; both rails fold
// away below 1280px. The markup follows the "09 Content page" boards in the
// Paper file: one h1, h2 per section (the rail links to their ids), a byline
// with rel=author and <time datetime>, figure/figcaption for media, and
// BlogPosting + BreadcrumbList JSON-LD in the head.
//
// Pure render — no env or DB access — so it can be tested with the post
// registry alone. Posts are code (src/http/posts/*), not a CMS: they ship
// with the Worker and are reviewed like any other change.
import type { JSX } from 'hono/jsx/jsx-runtime';
import { whyIBuiltThis } from './posts/why-i-built-this.tsx';
import { SHELL_CSS, REPO_URL, SITE_URL, SiteFooter, SiteHeader } from './site-shell.tsx';

export interface Author {
  name: string;
  role: string;
  handle: string;
  url: string;
  // Square source image, at least 96px; rendered at 48px and 64px.
  image: string;
  bio: string;
}

export interface Section {
  id: string;
  heading: string;
  body: JSX.Element;
}

export interface Post {
  slug: string;
  // Placard above the title, and the middle breadcrumb.
  category: string;
  title: string;
  // One or two sentences: the dek under the title and the meta description.
  dek: string;
  // ISO dates (YYYY-MM-DD), UTC.
  published: string;
  updated?: string;
  author: Author;
  tags: string[];
  sections: Section[];
}

const POSTS: readonly Post[] = [whyIBuiltThis];

const WORDS_PER_MINUTE = 220;

const CSS = `
	.post .wrap {
		display: grid; grid-template-columns: 240px minmax(0, 720px) 240px;
		column-gap: 56px; justify-content: center; align-items: start;
		padding: 4rem 0 6rem;
	}
	.rail {
		position: sticky; top: 2rem; padding-top: 12.25rem;
		display: flex; flex-direction: column; gap: 0.9rem;
		font-family: var(--mono); font-size: 0.75rem; line-height: 1.35;
	}
	.rail-label { font-size: 0.64rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--mute); }
	.toc { list-style: none; padding: 0 0 0 0.9rem; border-left: 1px solid var(--line); display: flex; flex-direction: column; gap: 0.6rem; }
	.toc a { color: var(--mute); transition: color 0.15s; }
	.toc a:hover { color: var(--ink); }
	.share { display: flex; flex-direction: column; gap: 0.6rem; }
	.share a { color: var(--ink-dim); transition: color 0.15s; }
	.share a:hover { color: var(--accent); }
	article { min-width: 0; }

	/* --- head --- */
	.crumbs { display: flex; flex-wrap: wrap; gap: 0.6rem; font-family: var(--mono); font-size: 0.75rem; color: var(--mute); }
	.crumbs a { color: var(--accent); }
	.crumbs .here { color: var(--ink-dim); }
	.head { display: flex; flex-direction: column; align-items: flex-start; gap: 1.25rem; margin-top: 1.25rem; }
	h1 {
		font-weight: 700; letter-spacing: -0.025em; line-height: 1.1;
		font-size: clamp(2.1rem, 4.2vw, 3.25rem); color: var(--ink);
	}
	.dek { font-size: clamp(1.1rem, 1.5vw, 1.25rem); line-height: 1.5; color: var(--ink-dim); }
	.byline {
		display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap;
		margin-top: 2rem; padding: 1.25rem 0;
		border-top: 1px solid var(--line); border-bottom: 1px solid var(--line);
	}
	.author { display: flex; align-items: center; gap: 0.9rem; font-style: normal; }
	.author img {
		width: 48px; height: 48px; border-radius: 50%; flex-shrink: 0;
		border: 1px solid var(--line-2); box-shadow: 2px 2px 0 var(--line); background: var(--raised);
	}
	.author b { display: block; font-size: 0.95rem; font-weight: 600; line-height: 1.3; }
	.author span { font-family: var(--mono); font-size: 0.75rem; color: var(--mute); }
	.author span a { color: var(--accent); }
	.when { display: flex; gap: 0.75rem; font-family: var(--mono); font-size: 0.75rem; color: var(--mute); }
	.when time { color: var(--ink-dim); }

	/* --- body --- */
	.body { display: flex; flex-direction: column; gap: 1.4rem; margin-top: 3rem; }
	.body h2 {
		font-weight: 600; letter-spacing: -0.015em; line-height: 1.25;
		font-size: clamp(1.5rem, 2.2vw, 1.875rem); margin-top: 1.6rem; scroll-margin-top: 2rem;
	}
	.body h2:first-child { margin-top: 0; }
	.body p { font-size: 1.125rem; line-height: 1.67; }
	.body a { color: var(--accent); text-decoration: underline; text-underline-offset: 4px; text-decoration-color: var(--line-2); }
	.body a:hover { text-decoration-color: var(--accent); }
	.body strong { font-weight: 600; }
	.body ul { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 0.75rem; }
	.body li { display: flex; gap: 0.9rem; font-size: 1.125rem; line-height: 1.67; }
	.body li::before { content: "\\2192"; font-family: var(--mono); color: var(--accent); flex-shrink: 0; width: 1.1em; }
	.body blockquote {
		padding: 0.4rem 0 0.4rem 1.5rem; border-left: 3px solid var(--accent);
		display: flex; flex-direction: column; gap: 0.6rem;
	}
	.body blockquote p { font-size: 1.375rem; line-height: 1.45; font-weight: 500; letter-spacing: -0.01em; }
	.body blockquote cite { font-style: normal; font-family: var(--mono); font-size: 0.75rem; color: var(--mute); }
	.note { display: flex; gap: 0.9rem; padding: 1rem 1.15rem; }
	.note .lamp { margin-top: 0.5rem; }
	.note .rail-label { color: var(--accent); }
	.note div { display: flex; flex-direction: column; gap: 0.25rem; }
	.body .note p { font-size: 0.95rem; line-height: 1.55; color: var(--ink-dim); }
	.loop { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.75rem; margin: 0.25rem 0; }
	.loop .card { padding: 1rem 1.1rem; display: flex; flex-direction: column; gap: 0.5rem; }
	.loop .top { display: flex; align-items: center; justify-content: space-between; }
	.loop .placard { font-size: 0.66rem; }
	.loop .n { font-family: var(--mono); font-size: 1.1rem; font-weight: 600; color: var(--line-2); }
	.body .loop p { font-size: 0.9rem; line-height: 1.5; color: var(--ink-dim); }

	/* --- foot --- */
	.post-foot { display: flex; flex-direction: column; gap: 2rem; margin-top: 3.5rem; padding-top: 2rem; border-top: 1px solid var(--line); }
	.tags { display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem; font-family: var(--mono); font-size: 0.75rem; }
	.tags .rail-label { margin-right: 0.4rem; }
	.tags span:not(.rail-label) { border: 1px solid var(--line-2); border-radius: 999px; padding: 0.25rem 0.65rem; color: var(--ink-dim); }
	.author-card { display: flex; gap: 1.1rem; padding: 1.4rem; font-style: normal; }
	.author-card img { width: 64px; height: 64px; border-radius: 50%; flex-shrink: 0; border: 1px solid var(--line-2); background: var(--raised); }
	.author-card div { display: flex; flex-direction: column; gap: 0.35rem; }
	.author-card b { font-size: 1.125rem; font-weight: 600; }
	.author-card p { font-size: 0.95rem; line-height: 1.55; color: var(--ink-dim); }
	.author-card .links { display: flex; gap: 1rem; margin-top: 0.25rem; font-family: var(--mono); font-size: 0.75rem; }
	.author-card .links a { color: var(--accent); }

	@media (max-width: 1279px) {
		.post .wrap { grid-template-columns: minmax(0, 720px); row-gap: 2.5rem; padding-top: 3rem; }
		.rail { position: static; padding-top: 0; }
		.rail.share { display: none; }
	}
	@media (max-width: 700px) {
		.loop { grid-template-columns: 1fr; }
		.author-card { flex-direction: column; }
	}
`;

function wordCount(html: string): number {
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/g, ' ')
    .trim();
  return text === '' ? 0 : text.split(/\s+/).length;
}

function longDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// BlogPosting + BreadcrumbList for the page head. JSON inside a <script>
// must not be able to close the tag, so "<" is escaped.
function structuredData(post: Post, url: string, image: string): string {
  const blocks = [
    {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: post.title,
      description: post.dek,
      image,
      url,
      mainEntityOfPage: url,
      datePublished: post.published,
      dateModified: post.updated ?? post.published,
      keywords: post.tags.join(', '),
      author: { '@type': 'Person', name: post.author.name, url: post.author.url },
      publisher: {
        '@type': 'Organization',
        name: 'Turbodiff',
        url: SITE_URL,
        logo: { '@type': 'ImageObject', url: `${SITE_URL}/logo.png` },
      },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Turbodiff', item: SITE_URL },
        { '@type': 'ListItem', position: 2, name: 'Blog', item: `${SITE_URL}/blog` },
        { '@type': 'ListItem', position: 3, name: post.title, item: url },
      ],
    },
  ];
  return JSON.stringify(blocks).replace(/</g, '\\u003c');
}

function Body({ post }: { post: Post }) {
  return (
    <div class="body">
      {post.sections.map((s) => (
        <>
          <h2 id={s.id}>{s.heading}</h2>
          {s.body}
        </>
      ))}
    </div>
  );
}

function PostPage({ post, bodyHtml }: { post: Post; bodyHtml: string }) {
  const url = `${SITE_URL}/blog/${post.slug}`;
  const image = `${SITE_URL}/logo.png`;
  const minutes = Math.max(1, Math.round(wordCount(bodyHtml) / WORDS_PER_MINUTE));
  const shareText = encodeURIComponent(post.title);
  const shareUrl = encodeURIComponent(url);
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${post.title} — Turbodiff`}</title>
        <meta name="description" content={post.dek} />
        <link rel="canonical" href={url} />
        <meta property="og:type" content="article" />
        <meta property="og:site_name" content="Turbodiff" />
        <meta property="og:title" content={post.title} />
        <meta property="og:description" content={post.dek} />
        <meta property="og:url" content={url} />
        <meta property="og:image" content={image} />
        <meta property="article:published_time" content={post.published} />
        <meta property="article:modified_time" content={post.updated ?? post.published} />
        <meta property="article:author" content={post.author.url} />
        {post.tags.map((tag) => (
          <meta key={tag} property="article:tag" content={tag} />
        ))}
        <meta name="twitter:card" content="summary" />
        <meta name="twitter:title" content={post.title} />
        <meta name="twitter:description" content={post.dek} />
        <meta name="twitter:image" content={image} />
        <link rel="icon" type="image/png" href="/logo-small.png" />
        <link rel="apple-touch-icon" href="/logo.png" />
        <meta name="theme-color" content="#ffc72c" />
        <link href="/fonts/fonts.css" rel="stylesheet" />
        <style dangerouslySetInnerHTML={{ __html: SHELL_CSS + CSS }} />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: structuredData(post, url, image) }}
        />
      </head>
      <body>
        <SiteHeader />

        <main class="post">
          <div class="wrap">
            <nav class="rail" aria-label="On this page">
              <span class="rail-label">on this page</span>
              <ol class="toc">
                {post.sections.map((s) => (
                  <li key={s.id}>
                    <a href={`#${s.id}`}>{s.heading}</a>
                  </li>
                ))}
              </ol>
            </nav>

            <article>
              <nav class="crumbs" aria-label="Breadcrumb">
                <a href="/">turbodiff</a>
                <span>/</span>
                <span>blog</span>
                <span>/</span>
                <span class="here">{post.slug}</span>
              </nav>
              <div class="head">
                <span class="tag flat">{post.category}</span>
                <h1>{post.title}</h1>
                <p class="dek">{post.dek}</p>
              </div>
              <div class="byline">
                <address class="author" rel="author">
                  <img
                    src={post.author.image}
                    alt={`${post.author.name}, ${post.author.role}`}
                    width="48"
                    height="48"
                  />
                  <div>
                    <b>{post.author.name}</b>
                    <span>
                      {post.author.role} &middot;{' '}
                      <a href={post.author.url}>@{post.author.handle}</a>
                    </span>
                  </div>
                </address>
                <div class="when">
                  <time datetime={post.published}>{longDate(post.published)}</time>
                  <span>&middot;</span>
                  <span>{minutes} min read</span>
                  {post.updated && post.updated !== post.published ? (
                    <>
                      <span>&middot;</span>
                      <span>
                        updated <time datetime={post.updated}>{longDate(post.updated)}</time>
                      </span>
                    </>
                  ) : null}
                </div>
              </div>

              <div dangerouslySetInnerHTML={{ __html: bodyHtml }} />

              <footer class="post-foot">
                <div class="tags">
                  <span class="rail-label">tagged</span>
                  {post.tags.map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
                <address class="card author-card" rel="author">
                  <img src={post.author.image} alt="" width="64" height="64" loading="lazy" />
                  <div>
                    <span class="rail-label">written by</span>
                    <b>{post.author.name}</b>
                    <p>{post.author.bio}</p>
                    <span class="links">
                      <a href={post.author.url}>github &rarr;</a>
                      <a href={REPO_URL}>turbodiff on github &rarr;</a>
                    </span>
                  </div>
                </address>
              </footer>
            </article>

            <aside class="rail share">
              <span class="rail-label">share</span>
              <div class="share">
                <a href={`https://x.com/intent/post?text=${shareText}&url=${shareUrl}`}>
                  post on x &rarr;
                </a>
                <a href={`https://news.ycombinator.com/submitlink?u=${shareUrl}&t=${shareText}`}>
                  hacker news &rarr;
                </a>
                <a href={REPO_URL}>star on github &rarr;</a>
              </div>
            </aside>
          </div>
        </main>

        <SiteFooter />
      </body>
    </html>
  );
}

export function findPost(slug: string): Post | undefined {
  return POSTS.find((post) => post.slug === slug);
}

// The body is rendered first so the read time comes from the words on the
// page, not a number typed into the post.
export function renderPost(post: Post): string {
  const bodyHtml = (<Body post={post} />).toString();
  return `<!doctype html>${(<PostPage post={post} bodyHtml={bodyHtml} />).toString()}`;
}
