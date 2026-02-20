import type { ParsedSection } from "../../app/status-model";
import type { Provider } from "../../types";
import { theme } from "../theme";

interface DetailPanelProps {
  provider: Provider;
  lines: string[];
  compact: boolean;
  tiny: boolean;
}

function lineColor(line: string): string {
  if (line.startsWith("ERROR:")) return theme.bad;
  if (line.includes("unavailable")) return theme.bad;
  if (line.includes("skipped")) return theme.warn;
  if (line.endsWith("window")) return theme.accent;
  if (line.startsWith("used")) return theme.warn;
  if (line.includes("remaining")) return theme.good;
  return theme.text;
}

export function DetailPanel({ provider, lines, compact, tiny }: DetailPanelProps) {
  return (
    <box
      width={compact ? "100%" : "64%"}
      border
      borderStyle="single"
      borderColor={theme.border}
      backgroundColor={theme.panel}
      flexDirection="column"
      paddingX={1}
      paddingY={0}
      title={tiny ? provider.label : ` ${provider.label} Details `}
    >
      {lines.length === 0 ? (
        <text fg={theme.muted}>Waiting for provider data...</text>
      ) : (
        lines.map((line, index) => {
          const colonIdx = line.indexOf(":");
          if (colonIdx > 0) {
            const key = line.slice(0, colonIdx + 1);
            const value = line.slice(colonIdx + 1).trimStart();
            return (
              <text key={`${index}:${line}`} fg={theme.text}>
                <span fg={theme.muted}>{key}</span> <span fg={lineColor(line)}>{value || " "}</span>
              </text>
            );
          }
          return (
            <text key={`${index}:${line}`} fg={lineColor(line)}>
              {line || " "}
            </text>
          );
        })
      )}
    </box>
  );
}
