# Fixer/codegen sandbox image (see docs/software-factory-design.md).
# The tag must match the installed @cloudflare/sandbox SDK version.
FROM docker.io/cloudflare/sandbox:0.12.4

# Coding agent CLI used by the fix runner. Preinstalled so fix runs don't pay
# an npm install on every container cold start.
RUN npm install -g @anthropic-ai/claude-code

EXPOSE 8080
