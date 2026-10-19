import { afterEach, describe, expect, test } from "bun:test"
import { fetchUsage, footerEntries, formatMoney, formatReset, parseUsage, tone } from "./usage"

const limit = (group: string, percent: number, extra: Record<string, unknown> = {}) => ({
  kind: "spend",
  group,
  percent,
  resets_at: "2026-10-26T00:00:00.000Z",
  severity: "normal",
  is_active: true,
  ...extra,
})

describe("parseUsage", () => {
  test("orders daily, weekly and monthly windows regardless of response order", () => {
    const usage = parseUsage({ limits: [limit("monthly", 5), limit("daily", 70), limit("weekly", 40)] })
    expect(usage.limits.map((l) => l.window)).toEqual(["daily", "weekly", "monthly"])
  })

  test("drops inactive and malformed entries", () => {
    const usage = parseUsage({
      limits: [limit("daily", 10, { is_active: false }), limit("weekly", Number.NaN), { percent: 3 }, limit("monthly", 20)],
    })
    expect(usage.limits.map((l) => l.window)).toEqual(["monthly"])
  })

  test("keeps only the active window and reads spend in cents", () => {
    const usage = parseUsage({
      extra_usage: { is_enabled: true, monthly_limit: 123000, used_credits: 4579, utilization: 4, currency: "USD" },
      limits: [limit("weekly", 2, { is_active: false }), limit("monthly", 4, { resets_at: "2026-11-01T00:00:00.000Z" })],
    })
    expect(usage).toEqual({
      limits: [{ window: "monthly", percent: 4, severity: "normal", resetsAt: "2026-11-01T00:00:00.000Z" }],
      spend: { used: 4579, limit: 123000, currency: "USD" },
    })
  })

  test("omits spend unless extra usage is enabled with a positive cap", () => {
    expect(parseUsage({ limits: [], extra_usage: { is_enabled: false, used_credits: 1, monthly_limit: 100 } }).spend).toBeUndefined()
    expect(parseUsage({ limits: [], extra_usage: { is_enabled: true, used_credits: 1, monthly_limit: 0 } }).spend).toBeUndefined()
  })

  test("tolerates an empty or unexpected body", () => {
    expect(parseUsage(undefined)).toEqual({ limits: [] })
    expect(parseUsage({ limits: "nope" })).toEqual({ limits: [] })
  })
})

describe("tone", () => {
  test("escalates with percent and severity", () => {
    expect(tone({ percent: 10, severity: "normal" })).toBe("normal")
    expect(tone({ percent: 85, severity: "normal" })).toBe("warning")
    expect(tone({ percent: 10, severity: "warning" })).toBe("warning")
    expect(tone({ percent: 100, severity: "normal" })).toBe("error")
    expect(tone({ percent: 10, severity: "critical" })).toBe("error")
  })
})

describe("formatReset", () => {
  const now = Date.parse("2026-10-19T00:00:00.000Z")

  test("uses the largest sensible unit", () => {
    expect(formatReset("2026-10-19T00:30:00.000Z", now)).toBe("30m")
    expect(formatReset("2026-10-19T05:10:00.000Z", now)).toBe("5h")
    expect(formatReset("2026-10-26T00:00:00.000Z", now)).toBe("7d")
  })

  test("returns nothing for past or invalid times", () => {
    expect(formatReset("2026-10-18T00:00:00.000Z", now)).toBeUndefined()
    expect(formatReset("not a date", now)).toBeUndefined()
  })
})

describe("formatMoney", () => {
  test("formats cents as currency", () => {
    expect(formatMoney(211, "USD")).toBe("$2.11")
    expect(formatMoney(123000, "USD")).toBe("$1,230.00")
  })

  test("falls back for an unknown currency code", () => {
    expect(formatMoney(500, "not-a-currency")).toBe("5.00 not-a-currency")
  })
})

describe("footerEntries", () => {
  const now = Date.parse("2026-10-19T00:00:00.000Z")

  test("shows the active window with spend against its cap", () => {
    const usage = parseUsage({
      extra_usage: { is_enabled: true, monthly_limit: 10000, used_credits: 211, utilization: 2, currency: "USD" },
      limits: [limit("weekly", 2)],
    })
    expect(footerEntries(usage, now)).toEqual([
      { text: "week 2%", tone: "normal" },
      { text: "$2.11 / $100.00", tone: "normal" },
    ])
  })

  test("renders every active window, adding the reset time only when close to the limit", () => {
    const usage = parseUsage({ limits: [limit("monthly", 5), limit("daily", 92), limit("weekly", 40)] })
    expect(footerEntries(usage, now)).toEqual([
      { text: "day 92% (resets 7d)", tone: "warning" },
      { text: "week 40%", tone: "normal" },
      { text: "month 5%", tone: "normal" },
    ])
  })

  test("warns as spend approaches its cap", () => {
    const usage = parseUsage({ limits: [], extra_usage: { is_enabled: true, monthly_limit: 10000, used_credits: 9500 } })
    expect(footerEntries(usage, now)).toEqual([{ text: "$95.00 / $100.00", tone: "warning" }])
  })
})

describe("fetchUsage", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("sends the bearer token and parses the response", async () => {
    let seen: Request | undefined
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen = new Request(url, init)
      return Response.json({ limits: [limit("daily", 15)] })
    }) as unknown as typeof fetch

    const usage = await fetchUsage("https://gateway.test/api/oauth/usage", "jwt", 1000)
    expect(seen?.headers.get("authorization")).toBe("Bearer jwt")
    expect(usage.limits).toHaveLength(1)
  })

  test("rejects on a non-2xx response", async () => {
    globalThis.fetch = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch
    await expect(fetchUsage("https://gateway.test/api/oauth/usage", "jwt", 1000)).rejects.toThrow(/401/)
  })
})
