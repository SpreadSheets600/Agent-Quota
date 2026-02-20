import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { providers } from "../app/providers";
import { getProviderSection } from "../app/status-model";
import { Footer } from "./components/Footer";
import { DetailPanel } from "./components/DetailPanel";
import { ProviderList } from "./components/ProviderList";
import { useStatusData } from "./hooks/useStatusData";
import { theme } from "./theme";

interface AppProps {
  refreshMs: number;
}

const SPARK_CHARS = "▁▂▃▄▅▆▇█";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sparkline(points: number[], width = 28): string {
  if (points.length === 0) return "·".repeat(width);
  const tail = points.slice(-width);
  const padded = tail.length < width ? Array.from({ length: width - tail.length }, () => 0).concat(tail) : tail;

  return padded
    .map((value) => {
      const idx = Math.max(0, Math.min(SPARK_CHARS.length - 1, Math.round((value / 100) * (SPARK_CHARS.length - 1))));
      return SPARK_CHARS[idx];
    })
    .join("");
}

function healthColor(value: number): string {
  if (value >= 80) return theme.good;
  if (value >= 55) return theme.warn;
  return theme.bad;
}

export function App({ refreshMs }: AppProps) {
  const renderer = useRenderer();
  const { height, width } = useTerminalDimensions();
  const compact = width < 112;
  const tiny = width < 78;
  const micro = width < 58;

  const { state, sections, summaries, health, selectedIndex, nextProvider, prevProvider, refreshNow } = useStatusData(
    providers,
    refreshMs,
  );

  const selectedSummary = summaries[selectedIndex] ?? summaries[0];
  const selectedProvider = selectedSummary?.provider ?? providers[0];
  const selectedSection = selectedProvider ? getProviderSection(sections, selectedProvider.label) : undefined;

  const detailLines = useMemo(() => {
    if (!selectedSection) return [];
    return selectedSection.lines;
  }, [selectedSection]);

  const detailHeight = Math.max(5, height - (compact ? (tiny ? 19 : 22) : 12));
  const maxOffset = Math.max(0, detailLines.length - detailHeight);
  const [detailOffset, setDetailOffset] = useState(0);
  const [healthHistory, setHealthHistory] = useState<number[]>([]);
  const lastHistoryKey = useRef("");

  useEffect(() => {
    const key = `${state.status}|${state.lastUpdated?.getTime() ?? 0}|${health}`;
    if (key === lastHistoryKey.current) return;

    lastHistoryKey.current = key;
    setHealthHistory((current) => {
      const next = [...current, health];
      if (next.length > 200) next.shift();
      return next;
    });
  }, [health, state.lastUpdated, state.status]);

  useEffect(() => {
    setDetailOffset(0);
  }, [selectedIndex]);

  useEffect(() => {
    setDetailOffset((current) => clamp(current, 0, maxOffset));
  }, [maxOffset]);

  const visibleLines = detailLines.slice(detailOffset, detailOffset + detailHeight);

  useKeyboard((key) => {
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      renderer.destroy();
      return;
    }

    if (key.name === "r") {
      void refreshNow();
      return;
    }

    if (key.name === "left") {
      prevProvider();
      return;
    }

    if (key.name === "right") {
      nextProvider();
      return;
    }

    if (key.name === "up") {
      setDetailOffset((current) => clamp(current - 1, 0, maxOffset));
      return;
    }

    if (key.name === "down") {
      setDetailOffset((current) => clamp(current + 1, 0, maxOffset));
      return;
    }

    if (key.name === "pageup") {
      setDetailOffset((current) => clamp(current - Math.max(3, Math.floor(detailHeight / 2)), 0, maxOffset));
      return;
    }

    if (key.name === "pagedown") {
      setDetailOffset((current) => clamp(current + Math.max(3, Math.floor(detailHeight / 2)), 0, maxOffset));
    }
  });

  const sideMessage =
    state.message ||
    (detailLines.length > detailHeight
      ? `lines ${detailOffset + 1}-${Math.min(detailOffset + detailHeight, detailLines.length)} of ${detailLines.length}`
      : "");

  const trend = sparkline(healthHistory, tiny ? 10 : compact ? 16 : 22);
  const trendColor = healthColor(health);

  return (
    <box width="100%" height="100%" backgroundColor={theme.bg} flexDirection="column" padding={1} gap={1}>
      <box
        border
        borderStyle="single"
        borderColor={theme.borderStrong}
        backgroundColor={theme.chrome}
        paddingX={1}
        justifyContent="center"
        alignItems="center"
      >
        {micro ? (
          <text fg={theme.accent}>
            <strong>QUOTA STATUS</strong>
          </text>
        ) : (
          <ascii-font text="QUOTA STATUS" font={tiny ? "tiny" : "block"} color={theme.accent} />
        )}
      </box>

      <box flexDirection={compact ? "column" : "row"} gap={1} flexGrow={1}>
        <ProviderList
          entries={summaries}
          selectedIndex={selectedIndex}
          compact={compact}
          tiny={tiny}
          terminalWidth={width}
          message={sideMessage}
        />
        <DetailPanel
          provider={selectedProvider}
          lines={visibleLines}
          compact={compact}
          tiny={tiny}
        />
      </box>

      <Footer
        state={state}
        refreshMs={refreshMs}
        trend={trend}
        trendColor={trendColor}
        compact={compact}
        tiny={tiny}
      />
    </box>
  );
}
