# Sandbox image for the AI site-chat editor (docs/plans/2026-08-20-site-chat-ai-editor.md §8).
#
# A chat turn runs the Claude Code CLI inside a throwaway container built from
# this image, with only the site's workspace mounted, capabilities dropped, and
# resources capped (see SandboxChatExecutor). Build once:
#
#   docker build -t siteio-chat-sandbox:latest docker/chat-sandbox
#
# Override the tag via SITEIO_CHAT_SANDBOX_IMAGE.
FROM node:22-bookworm-slim

# git: some agent workflows use it. ca-certificates: TLS to the LLM API.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code \
    && npm cache clean --force

# The workspace is bind-mounted here at run time (-v <workspace>:/work).
WORKDIR /work

# `claude` (from @anthropic-ai/claude-code) is the entrypoint the executor calls
# with -p/--output-format stream-json. No CMD: the executor supplies the argv.
