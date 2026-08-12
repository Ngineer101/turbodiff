# Fixer/codegen sandbox image (see docs/software-factory-design.md).
# The tag must match the installed @cloudflare/sandbox SDK version.
FROM docker.io/cloudflare/sandbox:0.12.4

# Coding agent CLIs used by the fix/generation runners (runner_credentials
# picks which one a given run authenticates as — see resolveRunnerAuth in
# src/lib/fixer.ts), plus pnpm for repos whose check_command installs
# dependencies. Preinstalled so runs don't pay the install on every container
# cold start. Codex is pinned like the sandbox base image above; bump its
# version independently of Claude Code's (which floats on latest).
RUN npm install -g @anthropic-ai/claude-code @openai/codex@0.147.0 pnpm

# Headless browser for the verification step (Phase 4): the verifier agent
# drives Chrome via puppeteer-core to capture screenshot evidence of the
# running app. The base is Ubuntu 22.04 where apt's chromium is a snap stub,
# so install Google's .deb (apt resolves its dependencies). NODE_PATH lets
# ad-hoc scripts require the global puppeteer-core install.
RUN apt-get update && \
	curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && \
	apt-get install -y --no-install-recommends /tmp/chrome.deb ffmpeg && \
	rm /tmp/chrome.deb && rm -rf /var/lib/apt/lists/* && \
	npm install -g puppeteer-core
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV NODE_PATH=/usr/local/lib/node_modules

EXPOSE 8080
