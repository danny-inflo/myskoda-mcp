---
name: deploy-myskoda
description: Deploy this MyŠkoda MCP repository to ChatGPT Sites or an owner-controlled Cloudflare account, or explain the deployment steps. Use the user's selected target and check hosting tools before provisioning.
---

Resolve the repository root containing `package.json` with name `myskoda-mcp`.
Read `AGENTS.md` and follow `docs/AGENT_DEPLOYMENT.md` from that root.

The argument `sites` or `cloudflare` selects the target. Preserve an explicit
target from the user's request. If the target is unknown, explain the two routes
and ask which to use. For a how-to question, provide instructions without making
external changes. The skill supplies a procedure, not account credentials or
hosting capabilities. Use the selected target's documented tools and workflow.
