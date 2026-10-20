import { afterEach, describe, expect, test } from "bun:test"
import { Provider } from "@opencode/plugin"
import { contextLimit, discoverAuthServer, modelDefinitions, oauthCredential } from "./index"

describe("contextLimit", () => {
  test.each([
    ["claude-sonnet-5-5", 1_000_000],
    ["us.anthropic.claude-sonnet-5-5-v1:0", 1_000_000],
    ["claude-opus-4-8", 1_000_000],
    ["anthropic.claude-opus-4-7-v1:0", 1_000_000],
    ["claude-haiku-5-5", 1_000_000],
    ["claude-fable-5-1", 1_000_000],
    ["claude-mythos-5", 1_000_000],
    ["claude-mythos-preview", 1_000_000],
    ["claude-sonnet-4-6", 200_000],
    ["claude-opus-4-6", 200_000],
    ["claude-sonnet-4-5-20250929", 200_000],
    ["custom-model-alias", 200_000],
  ])("returns the expected limit for %s", (id, limit) => {
    expect(contextLimit(id)).toBe(limit)
  })
})

describe("modelDefinitions", () => {
  test("adds an opt-in Sonnet 4.6 1M entry using the same wire model ID", () => {
    const [regular, extended] = modelDefinitions(Provider.ID.make("claude-gateway"), {
      id: "claude-sonnet-4-6",
      displayName: "Claude Sonnet 4.6",
    })

    expect(regular).toMatchObject({
      id: "claude-sonnet-4-6",
      modelID: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      limit: { context: 200_000 },
    })
    expect(extended).toMatchObject({
      id: "claude-sonnet-4-6[1m]",
      modelID: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6 [1M]",
      limit: { context: 1_000_000 },
      headers: { "anthropic-beta": "context-1m-2025-08-07" },
    })
  })

  test("adds the variant for provider-prefixed Sonnet 4.6 IDs only", () => {
    expect(
      modelDefinitions(Provider.ID.make("claude-gateway"), {
        id: "us.anthropic.claude-sonnet-4-6-v1:0",
      }),
    ).toHaveLength(2)
    expect(
      modelDefinitions(Provider.ID.make("claude-gateway"), {
        id: "claude-sonnet-4-5",
      }),
    ).toHaveLength(1)
  })
})

describe("oauthCredential", () => {
  test("throws when the gateway returns no access token", () => {
    expect(() => oauthCredential({ error: "invalid_grant" }, "old-refresh")).toThrow(/invalid_grant/)
  })

  test("builds a credential, carrying over the old refresh token when none is returned", () => {
    const before = Date.now()
    const credential = oauthCredential({ access_token: "jwt", expires_in: 7200 }, "old-refresh")
    expect(credential.access).toBe("jwt")
    expect(credential.refresh).toBe("old-refresh")
    expect(credential.expires).toBeGreaterThanOrEqual(before + 7200 * 1000)
  })

  test("prefers a freshly returned refresh token", () => {
    const credential = oauthCredential({ access_token: "jwt", refresh_token: "new-refresh", expires_in: 7200 }, "old-refresh")
    expect(credential.refresh).toBe("new-refresh")
  })
})

describe("discoverAuthServer", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("uses the discovery document when it's reachable and complete", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          device_authorization_endpoint: "https://gw.example.com/custom/device",
          token_endpoint: "https://gw.example.com/custom/token",
          scopes_supported: ["openid", "profile"],
        }),
        { status: 200 },
      )) as unknown as typeof fetch

    const result = await discoverAuthServer("https://gw.example.com", 1000)
    expect(result).toEqual({
      deviceUrl: "https://gw.example.com/custom/device",
      tokenUrl: "https://gw.example.com/custom/token",
      scope: "openid profile",
    })
  })

  test("falls back to conventional endpoints when discovery is unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down")
    }) as unknown as typeof fetch

    const result = await discoverAuthServer("https://gw.example.com", 1000)
    expect(result).toEqual({
      deviceUrl: "https://gw.example.com/oauth/device_authorization",
      tokenUrl: "https://gw.example.com/oauth/token",
      scope: "openid profile email",
    })
  })

  test("falls back when the discovery document is missing fields", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch

    const result = await discoverAuthServer("https://gw.example.com", 1000)
    expect(result).toEqual({
      deviceUrl: "https://gw.example.com/oauth/device_authorization",
      tokenUrl: "https://gw.example.com/oauth/token",
      scope: "openid profile email",
    })
  })
})
