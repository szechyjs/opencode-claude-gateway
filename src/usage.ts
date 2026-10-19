// The gateway serves the same account usage endpoint as Anthropic's OAuth API:
// `GET /api/oauth/usage` returns an `extra_usage` object and a `limits` array
// with one entry per quota window (daily, weekly, monthly, ...). Only the
// window currently enforced is `is_active`. `extra_usage` reports spend in
// minor units (cents) against the active window's cap — despite the name,
// `monthly_limit` is that cap, whichever window it belongs to.
export type Limit = {
  window: string
  percent: number
  severity: string
  resetsAt?: string
}

export type Spend = {
  used: number
  limit: number
  currency: string
}

export type Usage = {
  limits: Limit[]
  spend?: Spend
}

export type Tone = "normal" | "warning" | "error"

const WINDOW_ORDER = ["daily", "weekly", "monthly"]
const WINDOW_LABELS: Record<string, string> = { daily: "day", weekly: "week", monthly: "month" }
const WARNING_PERCENT = 80
const RESET_HINT_PERCENT = 80

function windowRank(window: string) {
  const index = WINDOW_ORDER.indexOf(window)
  return index === -1 ? WINDOW_ORDER.length : index
}

export function parseUsage(body: unknown): Usage {
  const source = (body ?? {}) as Record<string, any>
  const limits: Limit[] = (Array.isArray(source.limits) ? source.limits : [])
    .filter((entry: any) => entry?.is_active !== false && typeof entry?.group === "string" && Number.isFinite(entry?.percent))
    .map(
      (entry: any): Limit => ({
        window: entry.group,
        percent: entry.percent,
        severity: typeof entry.severity === "string" ? entry.severity : "normal",
        ...(typeof entry.resets_at === "string" ? { resetsAt: entry.resets_at } : {}),
      }),
    )
    .sort((a: Limit, b: Limit) => windowRank(a.window) - windowRank(b.window))

  const extra = source.extra_usage
  const hasSpend =
    extra?.is_enabled === true && Number.isFinite(extra.used_credits) && Number.isFinite(extra.monthly_limit) && extra.monthly_limit > 0
  if (!hasSpend) return { limits }
  return {
    limits,
    spend: { used: extra.used_credits, limit: extra.monthly_limit, currency: typeof extra.currency === "string" ? extra.currency : "USD" },
  }
}

export type FailureCode = "unreachable" | "timeout" | "unauthorized" | "http"

export class GatewayError extends Error {
  constructor(
    readonly code: FailureCode,
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

export async function fetchUsage(url: string, accessToken: string, timeout: number): Promise<Usage> {
  let response: Response
  try {
    response = await fetch(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(timeout),
      redirect: "error",
    })
  } catch (error: any) {
    if (error?.name === "TimeoutError") throw new GatewayError("timeout", "gateway timed out")
    throw new GatewayError("unreachable", "gateway unreachable")
  }
  if (response.status === 401 || response.status === 403) {
    throw new GatewayError("unauthorized", `gateway rejected the credential (HTTP ${response.status})`, response.status)
  }
  if (!response.ok) throw new GatewayError("http", `gateway returned HTTP ${response.status}`, response.status)
  return parseUsage(await response.json().catch(() => undefined))
}

export function tone(limit: Pick<Limit, "percent" | "severity">): Tone {
  const severity = limit.severity.toLowerCase()
  if (limit.percent >= 100 || !["normal", "ok", "info", "warning", "warn"].includes(severity)) return "error"
  if (limit.percent >= WARNING_PERCENT || severity === "warning" || severity === "warn") return "warning"
  return "normal"
}

export function formatReset(resetsAt: string, now = Date.now()) {
  const remaining = Date.parse(resetsAt) - now
  if (!Number.isFinite(remaining) || remaining <= 0) return undefined
  const minutes = Math.ceil(remaining / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export function windowLabel(window: string) {
  return WINDOW_LABELS[window] ?? window.replaceAll("_", " ")
}

export function formatMoney(minorUnits: number, currency: string) {
  const amount = minorUnits / 100
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount)
  } catch {
    return `${amount.toFixed(2)} ${currency}`
  }
}

export type FooterEntry = { text: string; tone: Tone }

export function footerEntries(usage: Usage, now = Date.now()): FooterEntry[] {
  const entries = usage.limits.map((limit): FooterEntry => {
    const reset = limit.percent >= RESET_HINT_PERCENT && limit.resetsAt ? formatReset(limit.resetsAt, now) : undefined
    return {
      text: `${windowLabel(limit.window)} ${Math.round(limit.percent)}%${reset ? ` (resets ${reset})` : ""}`,
      tone: tone(limit),
    }
  })
  if (usage.spend) {
    const { used, limit, currency } = usage.spend
    entries.push({
      text: `${formatMoney(used, currency)} / ${formatMoney(limit, currency)}`,
      tone: tone({ percent: (used / limit) * 100, severity: "normal" }),
    })
  }
  return entries
}
