# Fixer/codegen sandbox image (see docs/software-factory-design.md).
# The tag must match the installed @cloudflare/sandbox SDK version.
FROM docker.io/cloudflare/sandbox:0.12.4

# Coding agent CLI used by the fix/generation runners, plus pnpm for repos
# whose check_command installs dependencies. Preinstalled so runs don't pay
# the install on every container cold start.
RUN npm install -g @anthropic-ai/claude-code pnpm

EXPOSE 8080
