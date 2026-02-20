import type { AppState } from "../../types";
import { theme } from "../theme";

interface FooterProps {
  state: AppState;
  refreshMs: number;
  trend: string;
  trendColor: string;
  compact: boolean;
  tiny: boolean;
}

function appStatusLabel(status: AppState["status"]): string {
  if (status === "ok") return "LIVE";
  if (status === "loading") return "SYNCING";
  if (status === "error") return "ISSUE";
  return "IDLE";
}

function appStatusColor(status: AppState["status"]): string {
  if (status === "ok") return theme.good;
  if (status === "loading") return theme.warn;
  if (status === "error") return theme.bad;
  return theme.muted;
}

function formatClock(value: Date | null): string {
  if (!value) return "never";
  const hh = String(value.getHours()).padStart(2, "0");
  const mm = String(value.getMinutes()).padStart(2, "0");
  const ss = String(value.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function Footer({ state, refreshMs, trend, trendColor, compact, tiny }: FooterProps) {
  const updated = formatClock(state.lastUpdated);
  const auto = `${Math.round(refreshMs / 1000)}s`;
  const controls = tiny
    ? "R refresh | Q quit"
    : compact
      ? "←/→ provider | ↑/↓ scroll | R refresh | Q quit"
      : "←/→ provider | ↑/↓ scroll | PgUp/PgDn jump | R refresh | Q quit";

  return (
    <box border borderStyle="single" borderColor={theme.borderStrong} backgroundColor={theme.chrome} paddingX={1}>
      <text fg={theme.muted}>
        status <span fg={appStatusColor(state.status)}>{appStatusLabel(state.status)}</span>  |  updated{" "}
        <span fg={theme.text}>{updated}</span>  |  auto <span fg={theme.text}>{auto}</span>  |  trend{" "}
        <span fg={trendColor}>{trend}</span>  |  <span fg={theme.accentSoft}>{controls}</span>
      </text>
    </box>
  );
}
