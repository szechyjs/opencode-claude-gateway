import { describe, expect, test } from "bun:test"
import { announce, classifyFailure, footerHint, OFFLINE_INTERVAL, ONLINE_INTERVAL, pollInterval } from "./connection"

describe("classifyFailure", () => {
  const failure = (code: string) => ({ type: "unavailable", message: "x", data: { code } })

  test("maps gateway failure codes to statuses", () => {
    expect(classifyFailure(failure("unreachable"))).toBe("offline")
    expect(classifyFailure(failure("timeout"))).toBe("offline")
    expect(classifyFailure(failure("signed_out"))).toBe("signed_out")
    expect(classifyFailure(failure("unauthorized"))).toBe("unauthorized")
    expect(classifyFailure(failure("http"))).toBe("error")
    expect(classifyFailure(failure("something-new"))).toBe("error")
  })

  test("ignores errors that aren't gateway failures", () => {
    expect(classifyFailure({ type: "rpc.unavailable", message: "no plugin" })).toBeUndefined()
    expect(classifyFailure(new Error("boom"))).toBeUndefined()
    expect(classifyFailure(undefined)).toBeUndefined()
  })
})

describe("pollInterval and footerHint", () => {
  test("polls faster only while offline", () => {
    expect(pollInterval("offline")).toBe(OFFLINE_INTERVAL)
    expect(pollInterval("ok")).toBe(ONLINE_INTERVAL)
    expect(pollInterval(undefined)).toBe(ONLINE_INTERVAL)
  })

  test("hints only for problem states", () => {
    expect(footerHint("ok")).toBeUndefined()
    expect(footerHint(undefined)).toBeUndefined()
    expect(footerHint("offline")).toMatch(/VPN/)
    expect(footerHint("signed_out")).toMatch(/not signed in/)
  })
})

describe("announce", () => {
  test("a healthy first reading is silent", () => {
    expect(announce(undefined, "ok", true)).toEqual({ announced: "ok" })
  })

  test("going offline warns once, then stays quiet while still offline", () => {
    const first = announce("ok", "offline", true)
    expect(first.notice?.variant).toBe("warning")
    expect(first.notice?.message).toMatch(/VPN/)
    expect(announce(first.announced, "offline", true).notice).toBeUndefined()
  })

  test("recovering from a reported problem toasts a reconnect", () => {
    const result = announce("offline", "ok", true)
    expect(result.notice).toEqual({ variant: "success", message: "Claude gateway reconnected." })
    expect(result.announced).toBe("ok")
  })

  test("never toasts while another provider is selected, and catches up when a gateway model is chosen", () => {
    const inactive = announce(undefined, "offline", false)
    expect(inactive).toEqual({ announced: undefined })
    expect(announce(inactive.announced, "offline", true).notice?.variant).toBe("warning")
  })

  test("unknown status is ignored", () => {
    expect(announce("ok", undefined, true)).toEqual({ announced: "ok" })
  })

  test("distinguishes each problem state", () => {
    expect(announce("ok", "signed_out", true).notice?.message).toMatch(/Not signed in/)
    expect(announce("ok", "unauthorized", true).notice?.message).toMatch(/expired/)
    expect(announce("ok", "error", true).notice?.variant).toBe("error")
  })
})
