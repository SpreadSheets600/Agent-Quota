import { type SectionStatus, type ProviderSummary } from "../../app/status-model";
import { theme } from "../theme";

interface ProviderListProps {
  entries: ProviderSummary[];
  selectedIndex: number;
  compact: boolean;
  tiny: boolean;
  terminalWidth: number;
  message: string;
}

function statusColor(status: SectionStatus | undefined): string {
  if (status === "ok") return theme.good;
  if (status === "warning") return theme.warn;
  if (status === "error") return theme.bad;
  return theme.muted;
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width, " ");
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padStart(width, " ");
}

export function ProviderList({
  entries,
  selectedIndex,
  compact,
  tiny,
  terminalWidth,
  message,
}: ProviderListProps) {
  const maxName = Math.max(8, ...entries.map((entry) => entry.provider.label.length));
  const nameWidth = tiny ? 8 : Math.min(16, Math.max(10, maxName));
  const selectWidth = 3;
  const statusWidth = tiny ? 4 : compact ? 7 : 8;
  const barWidth = tiny ? 6 : compact ? 10 : 14;
  const scoreWidth = 5;
  const showStatus = !tiny;
  const showBar = !tiny || terminalWidth >= 66;
  const showScore = !tiny;

  return (
    <box
      width={compact ? "100%" : "36%"}
      minWidth={tiny ? 1 : 28}
      border
      borderStyle="single"
      borderColor={theme.border}
      backgroundColor={theme.panel}
      flexDirection="column"
      paddingX={1}
      paddingY={0}
    >
      <box marginTop={1} border borderStyle="single" borderColor={theme.border} flexDirection="column">
        <box backgroundColor={theme.panelAlt}>
          <text fg={theme.textStrong}>
            {"  "}
            {padRight("", selectWidth)} {" "}
            {padRight("Provider", nameWidth)}
            {showStatus ? ` ${padRight("Status", statusWidth)}` : ""}
            {showBar ? ` ${padRight("Usage", barWidth)}` : ""}
            {showScore ? ` ${padLeft("Rem", scoreWidth)}` : ""}{" "}
          </text>
        </box>

        {entries.map((entry, index) => {
          const selected = index === selectedIndex;
          const status = entry.section?.status;
          const statusText = padRight(status ? status.toUpperCase() : "IDLE", statusWidth);
          const pct = entry.avgRemaining === null ? "n/a" : `${entry.avgRemaining}%`;
          const healthValue = entry.avgRemaining ?? 0;
          const filled = entry.avgRemaining === null ? 0 : Math.round((healthValue / 100) * barWidth);
          const bar = "█".repeat(filled).padEnd(barWidth, "·");
          const rowBg = index % 2 === 1 ? theme.track : undefined;
          const bullet = selected ? "●" : "○";
          const name = padRight(entry.provider.label, nameWidth);
          const score = padLeft(pct, scoreWidth);
          const statusOut = showStatus ? ` ${statusText}` : "";
          const barOut = showBar ? ` ${bar}` : "";
          const scoreOut = showScore ? ` ${score}` : "";

          return (
            <box key={entry.provider.id} backgroundColor={rowBg}>
              <text fg={theme.text}>
                {"  "}
                <span fg={selected ? theme.accent : theme.muted}>{bullet}</span> {name}
                <span fg={statusColor(status)}>{statusOut}</span>
                <span fg={statusColor(status)}>{barOut}</span>
                <span fg={theme.muted}>{scoreOut}</span>{" "}
              </text>
            </box>
          );
        })}
      </box>

      {message ? (
        <box marginTop={1} border borderStyle="single" borderColor={theme.border}>
          <text fg={theme.warn}>{message}</text>
        </box>
      ) : null}
    </box>
  );
}
