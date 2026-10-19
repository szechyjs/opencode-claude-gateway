// The gateway lives on a private network, so being unreachable is routine
// (off VPN) rather than exceptional. These helpers turn usage-RPC outcomes into
// a connection status, the footer hint, and one toast per state change.
export type Status = "ok" | "offline" | "signed_out" | "unauthorized" | "error"

export type Notice = { variant: "info" | "success" | "warning" | "error"; message: string }

export const ONLINE_INTERVAL = 60_000
export const OFFLINE_INTERVAL = 15_000

const FAILURE_STATUS: Record<string, Status> = {
  unreachable: "offline",
  timeout: "offline",
  signed_out: "signed_out",
  unauthorized: "unauthorized",
  http: "error",
}

/** Maps a failed usage RPC to a status; undefined when it isn't a gateway failure (e.g. the server plugin isn't loaded). */
export function classifyFailure(error: unknown): Status | undefined {
  const failure = error as { type?: string; data?: { code?: string } } | undefined
  if (failure?.type !== "unavailable") return undefined
  return FAILURE_STATUS[failure.data?.code ?? ""] ?? "error"
}

export function pollInterval(status: Status | undefined) {
  return status === "offline" ? OFFLINE_INTERVAL : ONLINE_INTERVAL
}

const HINTS: Record<Exclude<Status, "ok">, string> = {
  offline: "Gateway offline — connect to your work network or VPN",
  signed_out: "Gateway: not signed in",
  unauthorized: "Gateway: session expired, sign in again",
  error: "Gateway: usage unavailable",
}

export function footerHint(status: Status | undefined) {
  return status && status !== "ok" ? HINTS[status] : undefined
}

const NOTICES: Record<Exclude<Status, "ok">, Notice> = {
  offline: {
    variant: "warning",
    message: "Can't reach the Claude gateway. Connect to your work network or VPN.",
  },
  signed_out: { variant: "warning", message: "Not signed in to the Claude gateway. Connect it from the provider list." },
  unauthorized: { variant: "warning", message: "Your Claude gateway session expired. Sign in again." },
  error: { variant: "error", message: "The Claude gateway returned an unexpected error." },
}

/**
 * Decides whether a status change deserves a toast. `announced` is the last
 * status the user was told about; it only advances while a gateway model is
 * selected, so someone using another provider is never nagged, and switching
 * to a gateway model while it's down still produces the toast. The first
 * healthy reading is silent; recovering from a reported problem is not.
 */
export function announce(
  announced: Status | undefined,
  current: Status | undefined,
  active: boolean,
): { announced: Status | undefined; notice?: Notice } {
  if (!active || !current || current === announced) return { announced }
  if (current === "ok") {
    return announced
      ? { announced: current, notice: { variant: "success", message: "Claude gateway reconnected." } }
      : { announced: current }
  }
  return { announced: current, notice: NOTICES[current] }
}
