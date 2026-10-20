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

type Context = Plugin.Context
type Connection = NonNullable<Awaited<ReturnType<Context["integration"]["connection"]["active"]>>>

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
// or dies at DNS, so no fetch here may be unbounded. Probes that only decide
// what to do next get a tight budget; a live request can afford to wait out a
// merely slow gateway. Nothing on the plugin's startup path touches the
// network, so being offline never delays opencode launching.
const PROBE_TIMEOUT = 3_000
const REQUEST_TIMEOUT = 15_000

// Model inventories depend on the account's group policy, so each connection
// has its own cache entry.
const STORAGE_MODELS_PREFIX = "models/"

// Footers poll the usage endpoint, so concurrent TUIs and repeated polls share
// one upstream request per window.
const USAGE_TTL = 30_000

// A model the gateway serves. The protocol's /v1/models response carries only
// `id`, an optional `display_name`, and an optional `description` — see
// https://code.claude.com/docs/en/llm-gateway-protocol#model-discovery. There
// is no pricing or context-limit field.
type GatewayModel = { id: string; displayName?: string }

const DEFAULT_CONTEXT_LIMIT = 200_000
const EXTENDED_CONTEXT_LIMIT = 1_000_000
const CONTEXT_1M_BETA = "context-1m-2025-08-07"

export function contextLimit(id: string) {
  const model = id.toLowerCase()
  if (model.includes("mythos-preview")) return EXTENDED_CONTEXT_LIMIT

  const match = model.match(
    /(?:^|[^a-z0-9])(?:claude[-._])?(fable|mythos|sonnet|opus|haiku)[-._]?(\d+)(?:[-._](\d+))?/,
  )
  if (!match) return DEFAULT_CONTEXT_LIMIT

  const [, family, majorText, minorText] = match
  const major = Number(majorText)
  const minor = Number(minorText ?? 0)
  const native1m =
    ((family === "fable" || family === "mythos" || family === "sonnet") && major >= 5) ||
    (family === "opus" && (major > 4 || (major === 4 && minor >= 7))) ||
    (family === "haiku" && (major > 5 || (major === 5 && minor >= 5)))

  // shortcut: unknown or aliased IDs stay at 200K; upgrade when discovery exposes context limits.
  return native1m ? EXTENDED_CONTEXT_LIMIT : DEFAULT_CONTEXT_LIMIT
}

/** Convert a gateway model into OpenCode definitions, including its opt-in 1M model when supported. */
export function modelDefinitions(providerID: Provider.ID, served: GatewayModel) {
  const model = Model.Info.default(providerID, Model.ID.make(served.id))
  const definition = {
    ...model,
    limit: { ...model.limit, context: contextLimit(served.id) },
    name: served.displayName ?? served.id,
  }
  if (!isSonnet46(served.id)) return [definition]

  return [
    definition,
    {
      ...definition,
      id: Model.ID.make(`${served.id}[1m]`),
      name: `${definition.name} [1M]`,
      limit: { ...definition.limit, context: EXTENDED_CONTEXT_LIMIT },
      headers: { "anthropic-beta": CONTEXT_1M_BETA },
    },
  ]
}

function isSonnet46(id: string) {
  return !/\[1m\]$/i.test(id) && /(?:^|[^a-z0-9])(?:claude[-._])?sonnet[-._]4[-._]6(?:[^0-9]|$)/i.test(id)
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

export type AuthServer = { deviceUrl: string; tokenUrl: string; scope: string }

function fallbackAuthServer(baseUrl: string): AuthServer {
  return {
    deviceUrl: `${baseUrl}${DEFAULT_DEVICE_PATH}`,
    tokenUrl: `${baseUrl}${DEFAULT_TOKEN_PATH}`,
    scope: DEFAULT_SCOPE,
  }
}

/**
 * Reads the OAuth device/token endpoints and scope from the gateway's RFC 8414
 * discovery document, which the quickstart's own verification step checks
 * first: https://code.claude.com/docs/en/claude-apps-gateway#quickstart.
 * Returns undefined when the document can't be fetched, so callers can retry
 * later instead of treating a network hiccup as the answer.
 */
async function fetchAuthServer(baseUrl: string, timeout: number): Promise<AuthServer | undefined> {
  const fallback = fallbackAuthServer(baseUrl)
  try {
    const response = await fetch(`${baseUrl}${DISCOVERY_PATH}`, { signal: AbortSignal.timeout(timeout) })
    if (!response.ok) return undefined
    const doc: any = await response.json().catch(() => undefined)
    if (!doc || typeof doc !== "object") return undefined
    const deviceUrl = typeof doc.device_authorization_endpoint === "string" ? doc.device_authorization_endpoint : fallback.deviceUrl
    const tokenUrl = typeof doc.token_endpoint === "string" ? doc.token_endpoint : fallback.tokenUrl
    const scopes = Array.isArray(doc.scopes_supported) ? doc.scopes_supported.filter((s: unknown) => typeof s === "string") : []
    const scope = scopes.length ? scopes.join(" ") : fallback.scope
    return { deviceUrl, tokenUrl, scope }
  } catch {
    return undefined
  }
}

/**
 * Falls back to the gateway's conventional `/oauth/device_authorization` +
 * `/oauth/token` paths and the `openid profile email` scope — the same
 * defaults shown in the quickstart — if discovery is slow or unreachable, so a
 * network hiccup doesn't block login entirely.
 */
export async function discoverAuthServer(baseUrl: string, timeout: number): Promise<AuthServer> {
  return (await fetchAuthServer(baseUrl, timeout)) ?? fallbackAuthServer(baseUrl)
}

/** Reads the model cache written by a previous run, tolerating bad/partial data. */
function parseCachedModels(value: unknown): GatewayModel[] | undefined {
  if (!Array.isArray(value)) return undefined
  const served = value
    .map((item) => (typeof item === "string" ? { id: item } : item))
    .filter((item): item is GatewayModel => typeof item?.id === "string")
  return served.length ? served : undefined
}

function connectionKey(connection: Connection) {
  return connection.type === "credential" ? connection.id : `env:${connection.name}`
}

const activeConnection = (ctx: Context) => ctx.integration.connection.active(PLUGIN).catch(() => undefined)

/**
 * The connection's access token, or undefined when it's expired and couldn't
 * be refreshed — typically because the gateway is unreachable.
 */
async function accessToken(ctx: Context, connection: Connection): Promise<string | undefined> {
  const credential = await ctx.integration.connection.resolve(connection).catch(() => undefined)
  if (credential?.type !== "oauth" || isStale(credential)) return undefined
  return credential.access
}

/**
 * Mirrors the real Claude Code client's gateway model discovery request: see
 * https://code.claude.com/docs/en/llm-gateway-protocol#request-and-response.
 * A redirect is treated as a failure so the credential can't leak to a
 * redirect target, same as the official client.
 */
async function discover(token: string, modelsUrl: string, timeout: number): Promise<GatewayModel[] | undefined> {
  try {
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

    // Resolved on first use rather than at startup. A successful lookup is kept
    // for the life of the plugin; a failed one is retried next time.
    let authServer: AuthServer | undefined
    const resolveAuthServer = async () => {
      authServer ??= await fetchAuthServer(baseUrl, PROBE_TIMEOUT)
      return authServer ?? fallbackAuthServer(baseUrl)
    }

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
          const { deviceUrl, tokenUrl, scope } = await resolveAuthServer()
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
          const { tokenUrl } = await resolveAuthServer()
          const json = await form(tokenUrl, {
            grant_type: "refresh_token",
            refresh_token: credential.refresh,
          })
          return oauthCredential(json, credential.refresh)
        },
      })
    })

    // The inventory is bound to the connection that produced it: OpenCode hides
    // the provider while a different connection is selected, until a refreshed
    // inventory for that connection is published.
    const source: { connection?: Connection; models: GatewayModel[] } = { models: [] }
    const readCache = async (connection: Connection) =>
      parseCachedModels(await ctx.storage.get(`${STORAGE_MODELS_PREFIX}${connectionKey(connection)}`))

    const initial = await activeConnection(ctx)
    if (initial) {
      source.connection = initial
      source.models = (await readCache(initial)) ?? []
    }

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
        // inventory without performing network I/O inside the callback.
        models: source.models.flatMap((served) => modelDefinitions(providerID, served)),
        ...(source.connection ? { sourceConnection: source.connection } : {}),
      })
    })

    const refreshModels = async () => {
      const connection = await activeConnection(ctx)
      if (!connection) return

      if (!source.connection || connectionKey(source.connection) !== connectionKey(connection)) {
        source.connection = connection
        source.models = (await readCache(connection)) ?? []
        await ctx.provider.reload()
      }

      const token = await accessToken(ctx, connection)
      const discovered = token ? await discover(token, modelsUrl, REQUEST_TIMEOUT) : undefined
      if (!discovered?.length || JSON.stringify(discovered) === JSON.stringify(source.models)) return
      if (!source.connection || connectionKey(source.connection) !== connectionKey(connection)) return

      source.models = discovered
      await ctx.storage.set(`${STORAGE_MODELS_PREFIX}${connectionKey(connection)}`, discovered)
      await ctx.provider.reload()
    }

    let refreshInFlight: Promise<void> | undefined
    const refresh = () => {
      refreshInFlight ??= refreshModels().finally(() => {
        refreshInFlight = undefined
      })
      return refreshInFlight
    }

    let cachedUsage: { token: string; at: number; usage: Usage } | undefined
    const rpc = await ctx.rpc.register(GatewayRpc, {
      usage: async (_input, context) => {
        const unavailable = (code: string, message: string) => context.error("unavailable", message, { code })
        const connection = await activeConnection(ctx)
        if (!connection) return unavailable("signed_out", "not signed in to the gateway")
        const token = await accessToken(ctx, connection)
        if (!token) {
          // Expired and not refreshable: unauthenticated probe tells an
          // unreachable gateway apart from a rejected refresh token.
          const probe = await fetchUsage(usageUrl, "", PROBE_TIMEOUT).catch((error) => error)
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
    const refreshQuietly = () => void refresh().catch((error) => log(`model refresh failed: ${error}`))
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type === "credential.switched" && event.data.integrationID === PLUGIN) refreshQuietly()
      }
    })().catch((error) => {
      if (!controller.signal.aborted) log(`event subscription failed: ${error}`)
    })

    const timer = setInterval(refreshQuietly, 60_000)
    refreshQuietly()

    return () => {
      controller.abort()
      clearInterval(timer)
      void rpc.dispose()
    }
  },
})
