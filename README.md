# opencode-claude-gateway

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
4. Adds a separate **Claude Sonnet 4.6 [1M]** model when the gateway exposes
   Sonnet 4.6, sending the same context-window beta header as Claude Code.
5. Shows your quota in the terminal UI footer (see [Quota footer](#quota-footer)).

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
      "package": "opencode-claude-gateway",
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

## Quota footer

While a Claude Gateway model is selected, the home and prompt footers show
your current quota window and spend:

```
Quota month 4% $45.79 / $1,230.00
```

The gateway enforces whichever limit is active for your account (daily, weekly
or monthly) and reports spend against that limit's cap, so the footer shows
that window's percent followed by `used / cap`. If several windows are active
they are all listed, in daily, weekly, monthly order. An entry turns yellow at
80% or when the gateway marks it as a warning, and red at 100% or for any more
severe state. The reset time appears once a window is at 80% or above.

The data comes from `GET <baseUrl>/api/oauth/usage`, fetched by the server
plugin with your gateway token, cached for 30 seconds, and refreshed by the
terminal UI every minute and after each completed step. If the gateway is
unreachable or you're signed out, the footer is simply hidden.

### Offline / VPN

Claude apps gateways run on a private network, so the gateway is routinely
unreachable away from the office or VPN. While a Claude Gateway model is
selected, the footer replaces the quota with a hint, and you get one toast per
change of state:

| State | Footer | Toast |
| ----- | ------ | ----- |
| Unreachable or timed out | `Gateway offline — connect to your work network or VPN` | warning |
| Not signed in | `Gateway: not signed in` | warning |
| Credential rejected or expired | `Gateway: session expired, sign in again` | warning |
| Any other HTTP error | `Gateway: usage unavailable` | error |
| Back online after a problem | quota returns | success |

Toasts fire only on a change, never on every poll, and never while another
provider is selected — switching to a gateway model while it's down shows the
toast then. While offline the footer re-checks every 15 seconds instead of 60,
and a failed prompt triggers an immediate re-check. Cached models stay
listed offline, so a prompt sent without a connection fails with OpenCode's
normal provider error.

The footer is a CLI plugin (`./tui`) shipped in the same package, so OpenCode
loads it automatically alongside the server plugin.

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
- No pricing metadata: the gateway's `/v1/models` response doesn't publish it.
  Known native 1M model IDs use their documented context limits; other models
  default to 200K. Sonnet 4.6's separate `[1M]` entry opts into extended
  context with `context-1m-2025-08-07`.
- One gateway per plugin instance; add the plugin twice with different
  options if you need more than one.
