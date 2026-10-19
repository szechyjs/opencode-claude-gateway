// Connects OpenCode to Anthropic's official Claude apps gateway
// (https://code.claude.com/docs/en/claude-apps-gateway) — the self-hosted
// `claude gateway` server, not a generic third-party gateway. It signs in with
// the same OAuth device-code flow the `claude` CLI uses, then registers the
// gateway as a provider backed by OpenCode's stock Anthropic provider package,
// since the gateway speaks the Anthropic Messages API
// (https://code.claude.com/docs/en/llm-gateway-protocol).
import { Integration, Model, Plugin, Provider } from "@opencode/plugin"
import { GatewayRpc } from "./rpc"
import { fetchUsage, GatewayError, type Usage } from "./usage"

const PLUGIN = "claude-gateway"
// Keep the V1-migrated credential method ID. OpenCode imports legacy OAuth
// entries with methodID "oauth"; using the same ID lets those credentials be
// refreshed by the V2 integration instead of waiting for a fresh login.
const AUTH_METHOD = Integration.MethodID.make("oauth")
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

const DISCOVERY_PATH = "/.well-known/oauth-authorization-server"
const DEFAULT_DEVICE_PATH = "/oauth/device_authorization"
const DEFAULT_TOKEN_PATH = "/oauth/token"
const DEFAULT_SCOPE = "openid profile email"

// Refresh this many ms before the access token actually expires.
const SKEW = 60_000

// The gateway may only be reachable over a VPN or from specific networks. Off
// that network a request to it either stalls on connect until the OS gives up
// or dies at DNS, so no fetch here may be unbounded — an unbounded one on the
// startup path hangs all of opencode. Startup gets a much tighter budget than
// a live request, which can afford to wait out a merely slow gateway.
const STARTUP_TIMEOUT = 3_000
const REQUEST_TIMEOUT = 15_000

const STORAGE_MODELS_KEY = "models"

// Footers poll the usage endpoint, so concurrent TUIs and repeated polls share
// one upstream request per window.
const USAGE_TTL = 30_000

// A model the gateway serves. The protocol's /v1/models response carries only
// `id`, an optional `display_name`, and an optional `description` — see
// https://code.claude.com/docs/en/llm-gateway-protocol#model-discovery. There
// is no pricing or context-limit field, so this plugin doesn't invent one;
// cost and limits are whatever OpenCode's model defaults are.
type GatewayModel = { id: string; displayName?: string }

/** Convert a model the gateway served into an OpenCode V2 model definition. */
function describe(providerID: any, served: GatewayModel) {
  return {
    ...Model.Info.default(providerID, Model.ID.make(served.id)),
    name: served.displayName ?? served.id,
  }
}

/** POSTs a form and normalizes the response to a plain object, never throwing. */
async function form(
  url: string,
  body: Record<string, string>,
  timeout = REQUEST_TIMEOUT,
): Promise<Record<string, any>> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(timeout),
    })
    const json = await response.json().catch(() => undefined)
    if (json) return json
    return { error: `http_${response.status}` }
  } catch (err: any) {
    // A transport failure here is the normal "gateway unreachable" case, not
    // an exception: report it like any other error response so callers
    // degrade gracefully.
    return { error: err?.name === "TimeoutError" ? "timeout" : "unreachable" }
  }
}

function isStale(info: { expires: number }) {
  return !Number.isFinite(info.expires) || info.expires - SKEW < Date.now()
}

function log(message: string) {
  console.error(`[${PLUGIN}] ${message}`)
}

function debug(message: string) {
  if (process.env.CLAUDE_GATEWAY_DEBUG) log(message)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Resolves the OAuth device/token endpoints and scope from the gateway's
 * RFC 8414 discovery document, which the quickstart's own verification step
 * checks first: https://code.claude.com/docs/en/claude-apps-gateway#quickstart.
 * Falls back to the gateway's conventional `/oauth/device_authorization` +
 * `/oauth/token` paths and the `openid profile email` scope — the same
 * defaults shown in that quickstart — if discovery is slow or unreachable at
 * startup, so a network hiccup doesn't block login entirely.
 */
export async function discoverAuthServer(baseUrl: string, timeout: number) {
  const fallback = {
    deviceUrl: `${baseUrl}${DEFAULT_DEVICE_PATH}`,
    tokenUrl: `${baseUrl}${DEFAULT_TOKEN_PATH}`,
    scope: DEFAULT_SCOPE,
  }
  try {
    const response = await fetch(`${baseUrl}${DISCOVERY_PATH}`, { signal: AbortSignal.timeout(timeout) })
    if (!response.ok) return fallback
    const doc: any = await response.json().catch(() => undefined)
    if (!doc || typeof doc !== "object") return fallback
    const deviceUrl = typeof doc.device_authorization_endpoint === "string" ? doc.device_authorization_endpoint : fallback.deviceUrl
    const tokenUrl = typeof doc.token_endpoint === "string" ? doc.token_endpoint : fallback.tokenUrl
    const scopes = Array.isArray(doc.scopes_supported) ? doc.scopes_supported.filter((s: unknown) => typeof s === "string") : []
    const scope = scopes.length ? scopes.join(" ") : fallback.scope
    return { deviceUrl, tokenUrl, scope }
  } catch {
    return fallback
  }
}

/** Reads the model cache written by a previous run, tolerating bad/partial data. */
function parseCachedModels(value: unknown): GatewayModel[] | undefined {
  if (!Array.isArray(value)) return undefined
  const served = value
    .map((item) => (typeof item === "string" ? { id: item } : item))
    .filter((item): item is GatewayModel => typeof item?.id === "string")
  return served.length ? served : undefined
}

/**
 * The active connection's access token. `signedIn` is false only when there is
 * no connection at all; a connection whose token can't be used (expired and
 * the refresh failed, typically because the gateway is unreachable) is still
 * signed in, just without a token.
 */
async function credentialState(ctx: any): Promise<{ signedIn: boolean; token?: string }> {
  const connection = await ctx.integration.connection.active(PLUGIN).catch(() => undefined)
  if (!connection) return { signedIn: false }
  const credential = await ctx.integration.connection.resolve(connection).catch(() => undefined)
  if (credential?.type !== "oauth" || isStale(credential)) return { signedIn: true }
  return { signedIn: true, token: credential.access }
}

/**
 * Mirrors the real Claude Code client's gateway model discovery request: see
 * https://code.claude.com/docs/en/llm-gateway-protocol#request-and-response.
 * A redirect is treated as a failure so the credential can't leak to a
 * redirect target, same as the official client.
 */
async function discover(ctx: any, modelsUrl: string, timeout: number): Promise<GatewayModel[] | undefined> {
  try {
    const { token } = await credentialState(ctx)
    if (!token) return undefined

    const response = await fetch(modelsUrl, {
      headers: { authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(timeout),
      redirect: "error",
    })
    if (!response.ok) return undefined
    const body = (await response.json()) as any
    const list = Array.isArray(body?.data) ? body.data : []
    const served: GatewayModel[] = list
      .filter((m: any) => typeof m?.id === "string")
      .map((m: any) => (typeof m.display_name === "string" ? { id: m.id, displayName: m.display_name } : { id: m.id }))
    return served.length ? served : undefined
  } catch {
    return undefined
  }
}

export function oauthCredential(json: Record<string, any>, refresh: string) {
  if (typeof json.access_token !== "string" || !json.access_token) {
    throw new Error(`${json.error ?? "gateway did not return an access token"}${json.error_description ? ` — ${json.error_description}` : ""}`)
  }
  const expiresIn = Number(json.expires_in)
  return {
    type: "oauth" as const,
    methodID: AUTH_METHOD,
    access: json.access_token,
    refresh: (json.refresh_token as string) || refresh,
    expires: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000,
  }
}

export default Plugin.define({
  id: PLUGIN,
  async setup(ctx) {
    const rawBaseUrl = ctx.options.baseUrl
    if (typeof rawBaseUrl !== "string" || !rawBaseUrl.trim()) {
      throw new Error(
        `[${PLUGIN}] "baseUrl" option is required, e.g. { "package": "opencode-claude-gateway", "options": { "baseUrl": "https://claude.example.com" } }`,
      )
    }
    const baseUrl = rawBaseUrl.trim().replace(/\/+$/, "")
    const displayName = (ctx.options.name as string | undefined)?.trim() || "Claude Gateway"
    const modelsUrl = `${baseUrl}/v1/models?limit=1000`
    const usageUrl = `${baseUrl}/api/oauth/usage`
    const providerID = Provider.ID.make(PLUGIN)

    const { deviceUrl, tokenUrl, scope } = await discoverAuthServer(baseUrl, STARTUP_TIMEOUT)

    // V2 stores provider credentials through its integration service rather than
    // auth.json. The integration method also gives V2 ownership of token refresh,
    // so provider requests automatically receive a current authToken — the stock
    // Anthropic provider package (registered below) handles the rest of the
    // wire protocol, so this plugin never touches requests or responses itself.
    await ctx.integration.transform((editor) => {
      editor.method.update({
        integrationID: PLUGIN,
        method: { id: AUTH_METHOD, type: "oauth", label: "Device login" },
        authorize: async () => {
          const device = await form(deviceUrl, { scope })
          if (!device.device_code) {
            throw new Error(`Device authorization failed: ${device.error ?? "no device_code in response"}`)
          }

          const url = device.verification_uri_complete ?? device.verification_uri
          if (typeof url !== "string" || !url) throw new Error("Device authorization response did not include a verification URL")

          let interval = Number(device.interval ?? 5) * 1000
          const deadline = Date.now() + Number(device.expires_in ?? 600) * 1000
          return {
            mode: "auto" as const,
            url,
            instructions: `Approve the code ${device.user_code} in your browser.`,
            callback: (async () => {
              while (Date.now() < deadline) {
                const json = await form(tokenUrl, {
                  grant_type: DEVICE_GRANT,
                  device_code: device.device_code,
                })
                if (json.error === "authorization_pending") {
                  await sleep(interval)
                  continue
                }
                if (json.error === "slow_down") {
                  // Per RFC 8628: permanently back off, don't just delay once.
                  interval += 5_000
                  await sleep(interval)
                  continue
                }
                if (!json.refresh_token) {
                  throw new Error("Device login succeeded but gateway returned no refresh_token")
                }
                return oauthCredential(json, json.refresh_token)
              }
              throw new Error("Device login timed out waiting for approval")
            })(),
          }
        },
        refresh: async (credential) => {
          const json = await form(tokenUrl, {
            grant_type: "refresh_token",
            refresh_token: credential.refresh,
          })
          return oauthCredential(json, credential.refresh)
        },
      })
    })

    const source: { models: GatewayModel[] } = {
      models: parseCachedModels(await ctx.storage.get(STORAGE_MODELS_KEY)) ?? [],
    }
    if (!source.models.length) {
      const discovered = await discover(ctx, modelsUrl, STARTUP_TIMEOUT)
      if (discovered?.length) {
        source.models = discovered
        await ctx.storage.set(STORAGE_MODELS_KEY, discovered)
      }
    }

    let modelDefinitions = source.models.map((served) => describe(providerID, served))

    await ctx.provider.transform((editor) => {
      editor.add({
        info: {
          ...Provider.Info.empty(providerID),
          name: displayName,
          activation: "enabled",
          integrationID: Integration.ID.make(PLUGIN),
          package: "@opencode/ai/providers/anthropic",
          settings: { baseURL: `${baseUrl}/v1` },
        },
        // The transform is replayed on reload, so it always sees the latest
        // discovered list without performing network I/O inside the callback.
        models: modelDefinitions,
      })
    })

    let refreshInFlight: Promise<void> | undefined
    const refresh = () => {
      if (!refreshInFlight) {
        refreshInFlight = (async () => {
          const discovered = await discover(ctx, modelsUrl, REQUEST_TIMEOUT)
          if (!discovered?.length) return
          if (JSON.stringify(discovered) === JSON.stringify(source.models)) return
          source.models = discovered
          modelDefinitions = discovered.map((served) => describe(providerID, served))
          await ctx.storage.set(STORAGE_MODELS_KEY, discovered)
          await ctx.provider.reload()
        })().finally(() => {
          refreshInFlight = undefined
        })
      }
      return refreshInFlight
    }

    let cachedUsage: { token: string; at: number; usage: Usage } | undefined
    const rpc = await ctx.rpc.register(GatewayRpc, {
      usage: async (_input, context) => {
        const unavailable = (code: string, message: string) => context.error("unavailable", message, { code })
        const { signedIn, token } = await credentialState(ctx)
        if (!signedIn) return unavailable("signed_out", "not signed in to the gateway")
        if (!token) {
          // Expired and not refreshable: unauthenticated probe tells an
          // unreachable gateway apart from a rejected refresh token.
          const probe = await fetchUsage(usageUrl, "", STARTUP_TIMEOUT).catch((error) => error)
          if (probe instanceof GatewayError && (probe.code === "unreachable" || probe.code === "timeout")) {
            return unavailable(probe.code, probe.message)
          }
          return unavailable("unauthorized", "gateway credential expired; sign in again")
        }
        if (cachedUsage?.token === token && Date.now() - cachedUsage.at < USAGE_TTL) return cachedUsage.usage
        try {
          const usage = await fetchUsage(usageUrl, token, REQUEST_TIMEOUT)
          cachedUsage = { token, at: Date.now(), usage }
          return usage
        } catch (error: any) {
          debug(`usage request failed: ${error?.message ?? error}`)
          if (error instanceof GatewayError) return unavailable(error.code, error.message)
          return unavailable("http", error?.message ?? "unexpected gateway response")
        }
      },
    })

    // Refresh after login/account switching and periodically while the gateway
    // is reachable. Abort the event stream and timer when the plugin unloads.
    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const data = (event as any).data ?? (event as any).properties
        if ((event as any).type === "credential.switched" && data?.integrationID === PLUGIN) {
          await refresh().catch((error) => log(`model refresh failed: ${error}`))
        }
      }
    })().catch((error) => {
      if (!controller.signal.aborted) log(`event subscription failed: ${error}`)
    })

    const timer = setInterval(() => void refresh().catch((error) => log(`model refresh failed: ${error}`)), 60_000)
    if (source.models.length) void refresh().catch(() => {})
    debug(`using OAuth endpoints: ${deviceUrl}, ${tokenUrl}`)

    return () => {
      controller.abort()
      clearInterval(timer)
      void rpc.dispose()
    }
  },
})
