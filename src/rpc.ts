import { Rpc } from "@opencode/plugin/rpc"

export const GatewayRpc = Rpc.define({
  id: "claude-gateway",
  methods: {
    usage: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: {
          limits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                window: { type: "string" },
                percent: { type: "number" },
                severity: { type: "string" },
                resetsAt: { type: "string" },
              },
              required: ["window", "percent", "severity"],
              additionalProperties: false,
            },
          },
          spend: {
            type: "object",
            properties: {
              used: { type: "number" },
              limit: { type: "number" },
              currency: { type: "string" },
            },
            required: ["used", "limit", "currency"],
            additionalProperties: false,
          },
        },
        required: ["limits"],
        additionalProperties: false,
      },
      errors: {
        unavailable: {
          type: "object",
          properties: { code: { type: "string" } },
          required: ["code"],
          additionalProperties: false,
        },
      },
    },
  },
  events: {},
})
