import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createRoot, createSignal, For, Show } from "solid-js"
import { announce, classifyFailure, footerHint, pollInterval, type Status } from "./connection"
import { GatewayRpc } from "./rpc"
import { footerEntries, type Tone, type Usage } from "./usage"

export default Plugin.define({
  id: "claude-gateway.tui",
  setup(context) {
    const rpc = context.client.rpc(GatewayRpc)
    const [usage, setUsage] = createSignal<Usage>()
    const [status, setStatus] = createSignal<Status>()

    let announced: Status | undefined
    let loading = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false

    const active = () => context.ui.model.current()?.providerID === "claude-gateway"

    const notify = () => {
      const result = announce(announced, status(), active())
      announced = result.announced
      if (result.notice) context.ui.toast.show({ title: "Claude Gateway", ...result.notice, duration: 8000 })
    }

    const refresh = async () => {
      if (loading) return
      loading = true
      try {
        setUsage((await rpc.usage({})) as Usage)
        setStatus("ok")
      } catch (error) {
        const failure = classifyFailure(error)
        setUsage(undefined)
        setStatus(failure)
      } finally {
        loading = false
      }
    }

    const schedule = () => {
      if (stopped) return
      timer = setTimeout(async () => {
        await refresh()
        schedule()
      }, pollInterval(status()))
    }

    const color = (tone: Tone) => (tone === "normal" ? context.theme.text.muted : context.theme.text.feedback[tone].base)
    const entries = () => {
      const current = usage()
      return current ? footerEntries(current) : []
    }
    const hint = () => footerHint(status())

    const disposeNotify = createRoot((dispose) => {
      createEffect(notify)
      return dispose
    })

    const footer = () => (
      <Show when={active()}>
        <Show
          when={hint()}
          fallback={
            <Show when={entries().length > 0}>
              <box flexDirection="row" gap={1}>
                <text fg={context.theme.text.muted}>Quota</text>
                <For each={entries()}>{(entry) => <text fg={color(entry.tone)}>{entry.text}</text>}</For>
              </box>
            </Show>
          }
        >
          <text fg={context.theme.text.feedback.warning.base}>{hint()}</text>
        </Show>
      </Show>
    )

    void refresh().then(schedule)
    const stopStep = context.data.on("session.step.ended", () => void refresh())
    // A failed prompt while on a gateway model: re-probe now so a dropped
    // connection is reported immediately instead of at the next poll.
    const stopFailed = context.data.on("session.execution.failed", () => {
      if (active()) void refresh()
    })
    const disposeHome = context.ui.slot({ append: "home.footer.status", render: footer })
    const disposePrompt = context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => <Show when={input.sessionID}>{footer()}</Show>,
    })

    return () => {
      stopped = true
      disposeNotify()
      clearTimeout(timer)
      stopStep()
      stopFailed()
      disposeHome()
      disposePrompt()
    }
  },
})
