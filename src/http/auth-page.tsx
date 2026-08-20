// Signed-out HTTP sign-in / sign-up page, server-rendered as a hono/jsx component
// like the landing page (no client React bundle). Two ways in: GitHub OAuth
// (/auth/login/github) or email + password against better-auth's JSON routes.
// The inline script posts the forms as JSON and redirects on success —
// sign-in lands on the board, sign-up on /onboarding (the optional
// connect-GitHub step). Same string-injection rule as landing.tsx: the
// script must not contain backticks or dollar-brace sequences.

const CSS = `
	:root {
		--bg: #15171c;
		--surface: #1b1e24;
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
		display: flex; flex-direction: column;
		padding: clamp(1.25rem, 3vw, 2.5rem);
	}
	header { display: flex; justify-content: center; }
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
	main { flex: 1; display: flex; align-items: center; justify-content: center; }
	.panel {
		width: 100%; max-width: 24rem;
		background: var(--surface);
		border: 1px solid var(--line); border-radius: 14px;
		padding: 1.75rem;
	}
	.tabs { display: flex; gap: 0.25rem; margin-bottom: 1.4rem; }
	.tab {
		flex: 1; padding: 0.45rem 0;
		font-family: var(--mono); font-size: 0.72rem; letter-spacing: 0.14em; text-transform: uppercase;
		color: var(--muted); background: none; border: none; border-bottom: 2px solid var(--line);
		cursor: pointer;
	}
	.tab[aria-selected="true"] { color: var(--ink); border-color: var(--green); }
	label {
		display: block; margin-bottom: 0.9rem;
		font-family: var(--mono); font-size: 0.7rem; letter-spacing: 0.12em; text-transform: uppercase;
		color: var(--muted);
	}
	input {
		display: block; width: 100%; margin-top: 0.3rem; padding: 0.55rem 0.7rem;
		font: inherit; font-size: 0.9rem; color: var(--ink);
		background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
	}
	input:focus { outline: none; border-color: var(--green); }
	.error {
		display: none; margin-bottom: 0.9rem; padding: 0.5rem 0.7rem;
		font-size: 0.82rem; color: var(--red);
		border: 1px solid rgba(248, 81, 73, 0.4); border-radius: 8px;
	}
	.error.show { display: block; }
	.submit {
		width: 100%; padding: 0.6rem 0; margin-top: 0.2rem;
		font: 500 0.9rem/1 "IBM Plex Sans", system-ui, sans-serif;
		color: #0b0f0c; background: var(--green); border: 1px solid var(--green-bright); border-radius: 8px;
		cursor: pointer;
	}
	.submit:hover { background: var(--green-bright); }
	.submit[disabled] { opacity: 0.6; cursor: default; }
	.divider {
		display: flex; align-items: center; gap: 0.8rem; margin: 1.2rem 0;
		font-family: var(--mono); font-size: 0.7rem; letter-spacing: 0.14em; text-transform: uppercase;
		color: var(--muted);
	}
	.divider::before, .divider::after { content: ""; flex: 1; height: 1px; background: var(--line); }
	.github {
		display: flex; align-items: center; justify-content: center; gap: 0.6rem;
		width: 100%; padding: 0.6rem 0;
		font: 500 0.9rem/1 "IBM Plex Sans", system-ui, sans-serif;
		color: var(--ink); background: none; border: 1px solid var(--line); border-radius: 8px;
		text-decoration: none;
	}
	.github:hover { border-color: var(--green); }
	.github svg { width: 18px; height: 18px; fill: currentColor; }
	footer {
		display: flex; justify-content: center; gap: 1.6rem;
		font-family: var(--mono); font-size: 0.78rem; color: var(--muted);
	}
	footer a { color: var(--muted); }
	footer a:hover { color: var(--ink); }
`;

// Posts the active form as JSON to better-auth. Error bodies are
// { code, message }; anything unparseable falls back to a generic line.
const SCRIPT = `
	var tabs = document.querySelectorAll('.tab');
	var forms = { signin: document.getElementById('signin'), signup: document.getElementById('signup') };
	tabs.forEach(function (tab) {
		tab.addEventListener('click', function () {
			tabs.forEach(function (t) { t.setAttribute('aria-selected', String(t === tab)); });
			Object.keys(forms).forEach(function (k) {
				forms[k].hidden = k !== tab.dataset.form;
			});
		});
	});
	function wire(form, endpoint, destination) {
		var error = form.querySelector('.error');
		var submit = form.querySelector('.submit');
		form.addEventListener('submit', function (event) {
			event.preventDefault();
			error.classList.remove('show');
			submit.disabled = true;
			var payload = {};
			new FormData(form).forEach(function (value, key) { payload[key] = value; });
			fetch(endpoint, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload),
			})
				.then(function (res) {
					if (res.ok) { window.location.href = destination; return; }
					return res.json().catch(function () { return {}; }).then(function (body) {
						error.textContent = body.message || 'That did not work — check the details and try again.';
						error.classList.add('show');
						submit.disabled = false;
					});
				})
				.catch(function () {
					error.textContent = 'Network error — try again.';
					error.classList.add('show');
					submit.disabled = false;
				});
		});
	}
	wire(forms.signin, '/api/auth/sign-in/email', '/');
	wire(forms.signup, '/api/auth/sign-up/email', '/onboarding');
`;

function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function AuthPage() {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Sign in — Turbodiff</title>
        <meta name="color-scheme" content="dark" />
        <link rel="icon" type="image/png" href="/logo-small.png" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <header>
          <a class="brand" href="/">
            <img src="/logo-small.png" alt="" />
            <span class="wordmark">
              turbo<b>diff</b>
            </span>
          </a>
        </header>

        <main>
          <div class="panel">
            <a class="github" href="/auth/login/github">
              <GitHubIcon />
              Continue with GitHub
            </a>

            <div class="divider">or</div>

            <div class="tabs" role="tablist">
              <button type="button" class="tab" role="tab" aria-selected="true" data-form="signin">
                Sign in
              </button>
              <button type="button" class="tab" role="tab" aria-selected="false" data-form="signup">
                Create account
              </button>
            </div>

            <form id="signin">
              <p class="error" role="alert"></p>
              <label>
                Email
                <input name="email" type="email" autocomplete="email" required />
              </label>
              <label>
                Password
                <input name="password" type="password" autocomplete="current-password" required />
              </label>
              <button class="submit" type="submit">
                Sign in
              </button>
            </form>

            <form id="signup" hidden>
              <p class="error" role="alert"></p>
              <label>
                Name
                <input name="name" type="text" autocomplete="name" required />
              </label>
              <label>
                Email
                <input name="email" type="email" autocomplete="email" required />
              </label>
              <label>
                Password
                <input
                  name="password"
                  type="password"
                  autocomplete="new-password"
                  minlength={8}
                  required
                />
              </label>
              <button class="submit" type="submit">
                Create account
              </button>
            </form>
          </div>
        </main>

        <footer>
          <a href="/">&larr; back</a>
        </footer>

        <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />
      </body>
    </html>
  );
}

export function renderAuthPage(): string {
  return `<!doctype html>${(<AuthPage />).toString()}`;
}
