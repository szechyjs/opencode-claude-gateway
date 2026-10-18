# @szechyjs/opencode-claude-gateway

An [OpenCode](https://opencode.ai) V2 plugin that connects to Anthropic's
official [Claude apps gateway](https://code.claude.com/docs/en/claude-apps-gateway)
— the self-hosted `claude gateway` server that normally serves the `claude`
CLI, Claude Code, and Claude Desktop. This plugin lets OpenCode sign in to
that same gateway and use the models it exposes.

It's a thin layer on top of OpenCode's stock `anthropic` provider package:

1. Registers an OAuth integration method that runs the same device-code
   sign-in flow as `claude /login` and refreshes tokens before they expire.
2. Points OpenCode's Anthropic provider at your gateway's `baseUrl` — the
   gateway speaks the [Anthropic Messages API](https://code.claude.com/docs/en/llm-gateway-protocol),
   so OpenCode's existing provider handles streaming, tool calls, etc.
   unmodified.
3. Polls the gateway's `/v1/models` endpoint, the same request the official
   client makes for [model discovery](https://code.claude.com/docs/en/llm-gateway-protocol#model-discovery),
   to list the models your group's policy actually grants.

## Requirements

- A deployed Claude apps gateway (`claude gateway --config gateway.yaml`),
  reachable from your machine. See the
  [quickstart](https://code.claude.com/docs/en/claude-apps-gateway#quickstart)
  if you're standing one up.
- Your account must be allowed to sign in per the gateway's IdP and
  [managed settings](https://code.claude.com/docs/en/managed-settings) policy.

## Install

```jsonc
// opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@szechyjs/opencode-claude-gateway",
      "options": {
        "baseUrl": "https://claude-gateway.internal.example.com"
      }
    }
  ]
}
```

| Option    | Required | Description                                                      |
| --------- | -------- | ----------------------------------------------------------------- |
| `baseUrl` | yes      | Your gateway's `listen.public_url`, e.g. `https://claude-gateway.internal.example.com`. |
| `name`    | no       | Display name for the provider. Defaults to `Claude Gateway`.      |

Set `CLAUDE_GATEWAY_DEBUG=1` for verbose logging.

## How the auth flow works

1. On setup, the plugin fetches `GET <baseUrl>/.well-known/oauth-authorization-server`
   to find the gateway's device-authorization and token endpoints (falling
   back to the gateway's conventional `/oauth/device_authorization` and
   `/oauth/token` paths if that's slow or unreachable).
2. When you authenticate in OpenCode, it runs the
   [OAuth device authorization grant](https://www.rfc-editor.org/rfc/rfc8628):
   you get a URL and a code to approve in your browser, the same experience
   as `claude /login`'s **Cloud gateway** screen.
3. OpenCode stores and refreshes the resulting token through its own
   integration/credential system — no API key ever touches your machine.

## Out of scope

- Enterprise managed-settings delivery (model allowlists, forced permissions,
  telemetry policy) isn't applied to OpenCode; the gateway still enforces
  model access server-side regardless.
- No pricing or context-limit metadata, since the gateway's `/v1/models`
  response doesn't publish any — see
  [model discovery](https://code.claude.com/docs/en/llm-gateway-protocol#model-discovery).
- One gateway per plugin instance; add the plugin twice with different
  options if you need more than one.
