import { Plugin } from "@opencode/plugin/tui"
import { createSignal, For, Show } from "solid-js"
import { GatewayRpc } from "./rpc"
import { footerEntries, type Tone, type Usage } from "./usage"

const REFRESH_INTERVAL = 60_000

export default Plugin.define({
  id: "claude-gateway.tui",
  setup(context) {
    const rpc = context.client.rpc(GatewayRpc)
    const [usage, setUsage] = createSignal<Usage>()

    let loading = false
    const refresh = async () => {
      if (loading) return
      loading = true
      try {
        setUsage((await rpc.usage({})) as Usage)
      } catch {
        setUsage(undefined)
      } finally {
        loading = false
      }
    }

    const color = (tone: Tone) => (tone === "normal" ? context.theme.text.muted : context.theme.text.feedback[tone].base)
    const active = () => context.ui.model.current()?.providerID === "claude-gateway"
    const entries = () => {
      const current = usage()
      return current ? footerEntries(current) : []
    }

    const footer = () => (
      <Show when={active() && entries().length > 0}>
        <box flexDirection="row" gap={1}>
          <text fg={context.theme.text.muted}>Quota</text>
          <For each={entries()}>{(entry) => <text fg={color(entry.tone)}>{entry.text}</text>}</For>
        </box>
      </Show>
    )

    void refresh()
    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL)
    const stop = context.data.on("session.step.ended", () => void refresh())
    const disposeHome = context.ui.slot({ append: "home.footer.status", render: footer })
    const disposePrompt = context.ui.slot({ append: "prompt.footer.status", render: footer })

    return () => {
      clearInterval(timer)
      stop()
      disposeHome()
      disposePrompt()
    }
  },
})
