#!/usr/bin/env bun

import blessed from "blessed";
import { codexProvider } from "./providers/codex";
import { copilotProvider } from "./providers/copilot";
import type { AppState, Provider } from "./types";

const providers: Provider[] = [copilotProvider, codexProvider];
const autoRefreshMs = Math.max(5000, Number(process.env.AGENT_STATUS_REFRESH_MS ?? "60000"));
const onceMode = process.argv.includes("--once");

const state: AppState = {
  lastUpdated: null,
  status: "idle",
  content: "",
  message: "Press r to refresh.",
};

let inflight = false;

function formatTime(d: Date | null): string {
  if (!d) return "never";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function buildOutputHeader(): string {
  return `Agent Status TUI | status=${state.status.toUpperCase()} | updated=${formatTime(state.lastUpdated)}`;
}

async function refresh(): Promise<void> {
  if (inflight) return;

  inflight = true;
  state.status = "loading";
  state.message = `Querying ${providers.map((p) => p.label).join(", ")}...`;

  try {
    const results = await Promise.all(
      providers.map(async (provider) => ({ provider, result: await provider.query() })),
    );

    state.lastUpdated = new Date();

    const sections: string[] = [];
    const failures: string[] = [];

    for (const { provider, result } of results) {
      if (result.success) {
        sections.push(`## ${provider.label}\n${result.output}`);
      } else {
        sections.push(`## ${provider.label}\nERROR: ${result.error}`);
        failures.push(`${provider.label}: ${result.error}`);
      }
    }

    state.content = sections.join("\n\n");
    state.status = failures.length === 0 ? "ok" : "error";
    state.message = failures.length === 0 ? "" : `${failures.length} provider(s) failed.`;
  } catch (error) {
    state.status = "error";
    state.content = "";
    state.message = error instanceof Error ? error.message : String(error);
  } finally {
    inflight = false;
  }
}

type ParsedSection = {
  name: string;
  lines: string[];
  status: "ok" | "warning" | "error";
};

const SPARK_CHARS = "▁▂▃▄▅▆▇█";

function parseSections(content: string): ParsedSection[] {
  if (!content.trim()) return [];

  const sections: ParsedSection[] = [];
  let active: ParsedSection | null = null;

  for (const line of content.split("\n")) {
    if (line.startsWith("## ")) {
      if (active) sections.push(active);
      active = { name: line.slice(3).trim(), lines: [], status: "ok" };
      continue;
    }

    if (!active) {
      active = { name: "General", lines: [], status: "ok" };
    }

    active.lines.push(line);
  }

  if (active) sections.push(active);

  for (const section of sections) {
    if (section.lines.some((line) => line.startsWith("ERROR:") || line.includes("unavailable"))) {
      section.status = "error";
      continue;
    }
    if (section.lines.some((line) => line.includes("skipped"))) {
      section.status = "warning";
    }
  }

  return sections;
}

function sectionStatusLabel(section: ParsedSection | undefined): string {
  if (!section) return "{white-fg}IDLE{/}";
  if (section.status === "error") return "{red-fg}ISSUE{/}";
  if (section.status === "warning") return "{yellow-fg}PARTIAL{/}";
  return "{green-fg}LIVE{/}";
}

function getProviderSection(sections: ParsedSection[], providerName: string): ParsedSection | undefined {
  const target = providerName.toLowerCase();
  return sections.find((section) => section.name.toLowerCase() === target);
}

function buildMeter(percent: number, width = 24): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
}

function healthScore(sections: ParsedSection[]): number {
  if (sections.length === 0) return 0;
  const total = sections.length;
  let points = 0;
  for (const section of sections) {
    if (section.status === "ok") points += 1;
    if (section.status === "warning") points += 0.5;
  }
  return Math.round((points / total) * 100);
}

function scoreColor(score: number): "green" | "yellow" | "red" {
  if (score >= 80) return "green";
  if (score >= 55) return "yellow";
  return "red";
}

function sparkline(points: number[], width = 18): string {
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

function extractRemainingPercents(section: ParsedSection | undefined): number[] {
  if (!section) return [];
  const values: number[] = [];
  for (const line of section.lines) {
    const match = line.match(/\b(\d{1,3})%\s+remaining\b/i);
    if (!match) continue;
    const percent = Number(match[1]);
    if (Number.isFinite(percent)) {
      values.push(Math.max(0, Math.min(100, percent)));
    }
  }
  return values;
}

function formatProviderPanel(
  providerName: string,
  accent: "cyan" | "yellow",
  section: ParsedSection | undefined,
): string {
  const out: string[] = [];
  const remaining = extractRemainingPercents(section);
  const avgRemaining =
    remaining.length > 0 ? Math.round(remaining.reduce((sum, value) => sum + value, 0) / remaining.length) : null;

  out.push(`{bold}{${accent}-fg}${providerName.toUpperCase()}{/}{/}  ${sectionStatusLabel(section)}`);
  out.push("{gray-fg}────────────────────────────────────────────────────────{/}");
  if (avgRemaining !== null) {
    out.push(`{gray-fg}quota{/} {${accent}-fg}${buildMeter(avgRemaining, 20)}{/} {bold}${avgRemaining}%{/}`);
  }
  out.push("");

  if (!section) {
    out.push("{gray-fg}Waiting for provider data...{/}");
    return out.join("\n");
  }

  const lines = section.lines;
  for (const line of lines) {
    if (!line.trim()) {
      out.push(" ");
      continue;
    }
    if (line.startsWith("ERROR:")) {
      out.push(`{red-fg}${line}{/}`);
      continue;
    }
    if (line.includes("skipped")) {
      out.push(`{yellow-fg}${line}{/}`);
      continue;
    }
    if (line.includes("unavailable")) {
      out.push(`{red-fg}${line}{/}`);
      continue;
    }
    if (line.toLowerCase().endsWith("window")) {
      out.push(`{bold}{white-fg}${line}{/}{/}`);
      continue;
    }
    const keyValue = line.match(/^([A-Za-z0-9+ -]+?)\s{2,}(.*)$/);
    if (keyValue) {
      const key = keyValue[1].trim().padEnd(12, " ");
      const value = keyValue[2];
      if (value.includes("[") && value.includes("]") && (value.includes("█") || value.includes("·") || value.includes("#"))) {
        out.push(`{gray-fg}${key}{/} {${accent}-fg}${value}{/}`);
        continue;
      }
      if (keyValue[1].toLowerCase().includes("raw")) {
        out.push(`{gray-fg}${key}{/} {gray-fg}${value}{/}`);
        continue;
      }
      out.push(`{gray-fg}${key}{/} ${value}`);
      continue;
    }
    if (line.includes("[") && line.includes("]") && (line.includes("#") || line.includes("█") || line.includes("·"))) {
      out.push(`{${accent}-fg}${line}{/}`);
      continue;
    }
    out.push(line || " ");
  }

  return out.join("\n").trim();
}

function countLines(content: string): number {
  if (!content) return 0;
  return content.split("\n").length;
}

function buildTopMetrics(
  state: AppState,
  sections: ParsedSection[],
  activePanel: "copilot" | "codex",
  history: number[],
  layoutMode: string,
): string {
  const score = healthScore(sections);
  const color = scoreColor(score);
  const ok = sections.filter((section) => section.status === "ok").length;
  const warn = sections.filter((section) => section.status === "warning").length;
  const err = sections.filter((section) => section.status === "error").length;
  const statusLabel =
    state.status === "error"
      ? "{red-fg}ISSUE{/}"
      : state.status === "loading"
        ? "{yellow-fg}SYNCING{/}"
        : state.status === "ok"
          ? "{green-fg}LIVE{/}"
          : "{white-fg}IDLE{/}";

  return [
    `{gray-fg}updated{/} {cyan-fg}${formatTime(state.lastUpdated)}{/}   {gray-fg}focus{/} {bold}${activePanel}{/}   {gray-fg}layout{/} {magenta-fg}${layoutMode}{/}`,
    `{gray-fg}health{/} {${color}-fg}${buildMeter(score, 28)}{/} {bold}${score}%{/}   {gray-fg}providers{/} {green-fg}${ok} ok{/} {yellow-fg}${warn} warn{/} {red-fg}${err} issue{/}   {gray-fg}trend{/} {cyan-fg}${sparkline(history, 20)}{/}`,
  ].join("\n");
}

function findLine(section: ParsedSection | undefined, re: RegExp): string | null {
  if (!section) return null;
  const found = section.lines.find((line) => re.test(line));
  return found ?? null;
}

function buildInsightsContent(
  copilot: ParsedSection | undefined,
  codex: ParsedSection | undefined,
  history: number[],
): string {
  const copilotRemaining = extractRemainingPercents(copilot);
  const codexRemaining = extractRemainingPercents(codex);
  const copilotAvg =
    copilotRemaining.length > 0
      ? Math.round(copilotRemaining.reduce((sum, value) => sum + value, 0) / copilotRemaining.length)
      : null;
  const codexAvg =
    codexRemaining.length > 0 ? Math.round(codexRemaining.reduce((sum, value) => sum + value, 0) / codexRemaining.length) : null;

  const lines: string[] = [];
  lines.push("{bold}{green-fg}INSIGHTS RAIL{/}{/}");
  lines.push("{gray-fg}────────────────────────────{/}");
  lines.push("");
  lines.push("{bold}Quota Radar{/bold}");
  lines.push(`Copilot {yellow-fg}${copilotAvg !== null ? `${copilotAvg}%` : "n/a"}{/}`);
  lines.push(`Codex   {cyan-fg}${codexAvg !== null ? `${codexAvg}%` : "n/a"}{/}`);
  lines.push("");
  lines.push("{bold}Next Reset{/bold}");
  lines.push(
    `{yellow-fg}Copilot{/} ${findLine(copilot, /^Resets\s+/i)?.replace(/^Resets\s+/, "") ?? "{gray-fg}n/a{/}"}`,
  );
  lines.push(`{cyan-fg}Codex{/} ${findLine(codex, /^resets in\s+/i)?.replace(/^resets in\s+/i, "") ?? "{gray-fg}n/a{/}"}`);
  const codexAt = findLine(codex, /^reset at\s+/i);
  if (codexAt) {
    lines.push(`{gray-fg}${codexAt}{/}`);
  }
  lines.push("");
  lines.push("{bold}Stability{/bold}");
  lines.push(`{magenta-fg}${sparkline(history, 26)}{/}`);
  lines.push("");
  lines.push("{bold}Legend{/bold}");
  lines.push("{green-fg}●{/} live");
  lines.push("{yellow-fg}●{/} partial");
  lines.push("{red-fg}●{/} issue");
  return lines.join("\n");
}

async function runOnce(): Promise<void> {
  await refresh();
  const lines = [buildOutputHeader(), "", state.content || state.message];
  process.stdout.write(`${lines.join("\n")}\n`);
  process.exit(state.status === "error" ? 1 : 0);
}

async function runBlessed(): Promise<void> {
  const screen = blessed.screen({
    smartCSR: true,
    title: "Agent Status Command Center",
    fullUnicode: true,
  });

  const header = blessed.box({
    top: 0,
    left: 0,
    width: "100%",
    height: 3,
    tags: true,
    border: { type: "line" },
    style: {
      border: { fg: "cyan" },
      fg: "white",
    },
    content: "",
  });

  const metrics = blessed.box({
    top: 3,
    left: 0,
    width: "100%",
    height: 4,
    tags: true,
    border: { type: "line" },
    style: {
      border: { fg: "magenta" },
      fg: "white",
    },
    content: "",
  });

  const insights = blessed.box({
    top: 7,
    left: "70%",
    width: "30%",
    bottom: 1,
    tags: true,
    border: { type: "line" },
    style: {
      border: { fg: "green" },
      fg: "white",
    },
    content: "",
  });

  const copilotPanel = blessed.box({
    top: 7,
    left: 0,
    width: "50%",
    bottom: 1,
    tags: true,
    border: { type: "line" },
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    mouse: true,
    scrollbar: {
      ch: " ",
      style: { fg: "yellow" },
    },
    style: {
      border: { fg: "yellow" },
      fg: "white",
    },
    content: "",
  });

  const codexPanel = blessed.box({
    top: 7,
    left: "50%",
    width: "50%",
    bottom: 1,
    tags: true,
    border: { type: "line" },
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    mouse: true,
    scrollbar: {
      ch: " ",
      style: { fg: "cyan" },
    },
    style: {
      border: { fg: "cyan" },
      fg: "white",
    },
    content: "",
  });

  const footer = blessed.box({
    bottom: 0,
    left: 0,
    width: "100%",
    height: 1,
    tags: true,
    style: {
      fg: "gray",
    },
    content: "r refresh  |  q quit  |  tab switch panel  |  arrows/pgup/pgdn scroll  |  auto",
  });

  screen.append(header);
  screen.append(metrics);
  screen.append(copilotPanel);
  screen.append(codexPanel);
  screen.append(insights);
  screen.append(footer);

  let activePanel: "copilot" | "codex" = "copilot";
  const healthHistory: number[] = [];
  let layoutMode = "dual";
  let lastHistoryKey = "";

  function focusedBox(): blessed.Widgets.BoxElement {
    return activePanel === "copilot" ? copilotPanel : codexPanel;
  }

  function applyFocusStyles() {
    copilotPanel.style.border = { fg: activePanel === "copilot" ? "light-yellow" : "yellow" };
    codexPanel.style.border = { fg: activePanel === "codex" ? "light-cyan" : "cyan" };
  }

  function applyResponsiveLayout(copilotLines: number, codexLines: number) {
    const cols = screen.width as number;
    const rows = screen.height as number;
    const headerHeight = 3;
    const metricsHeight = 4;
    const footerHeight = 1;
    const bodyTop = headerHeight + metricsHeight;
    const bodyHeight = Math.max(8, rows - bodyTop - footerHeight);

    if (cols >= 155 && rows >= 34) {
      layoutMode = "studio";
      insights.show();

      const railWidth = Math.max(30, Math.floor(cols * 0.3));
      const mainWidth = cols - railWidth;
      const topHeight = Math.max(10, Math.floor(bodyHeight * 0.45));
      const bottomHeight = bodyHeight - topHeight;

      copilotPanel.top = bodyTop;
      copilotPanel.left = 0;
      copilotPanel.width = mainWidth;
      copilotPanel.height = topHeight;
      copilotPanel.show();

      codexPanel.top = bodyTop + topHeight;
      codexPanel.left = 0;
      codexPanel.width = mainWidth;
      codexPanel.height = bottomHeight;
      codexPanel.show();

      insights.top = bodyTop;
      insights.left = mainWidth;
      insights.width = railWidth;
      insights.height = bodyHeight;
      return;
    }

    insights.hide();

    if (cols >= 120) {
      layoutMode = "dual";
      const leftWidth = Math.floor(cols / 2);
      const rightWidth = cols - leftWidth;

      copilotPanel.top = bodyTop;
      copilotPanel.left = 0;
      copilotPanel.width = leftWidth;
      copilotPanel.height = bodyHeight;

      codexPanel.top = bodyTop;
      codexPanel.left = leftWidth;
      codexPanel.width = rightWidth;
      codexPanel.height = bodyHeight;
      copilotPanel.show();
      codexPanel.show();
      return;
    }

    if (cols < 98) {
      layoutMode = "focus";
      const box = activePanel === "copilot" ? copilotPanel : codexPanel;
      const hidden = activePanel === "copilot" ? codexPanel : copilotPanel;

      box.top = bodyTop;
      box.left = 0;
      box.width = "100%";
      box.height = bodyHeight;
      box.show();
      hidden.hide();
      return;
    }

    layoutMode = "stack";
    const lineWeightTop = Math.max(10, copilotLines);
    const lineWeightBottom = Math.max(10, codexLines);
    const totalWeight = lineWeightTop + lineWeightBottom;

    let topHeight = Math.round((lineWeightTop / totalWeight) * bodyHeight);
    topHeight = Math.max(8, Math.min(bodyHeight - 8, topHeight));
    const bottomHeight = bodyHeight - topHeight;

    copilotPanel.top = bodyTop;
    copilotPanel.left = 0;
    copilotPanel.width = "100%";
    copilotPanel.height = topHeight;

    codexPanel.top = bodyTop + topHeight;
    codexPanel.left = 0;
    codexPanel.width = "100%";
    codexPanel.height = bottomHeight;
    copilotPanel.show();
    codexPanel.show();
  }

  function repaint() {
    applyFocusStyles();
    const msg = state.message ? ` {gray-fg}${state.message}{/}` : "";

    header.setContent(
      `{bold}{cyan-fg}QUOTA STATUS BOARD{/}\n` +
      `{gray-fg}GitHub Copilot + Codex usage telemetry{/}  {gray-fg}refresh{/} ${Math.round(autoRefreshMs / 1000)}s${msg}`,
    );

    const sections = parseSections(state.content);
    const score = healthScore(sections);
    const historyKey = `${state.status}|${state.lastUpdated?.getTime() ?? 0}|${score}`;
    if (historyKey !== lastHistoryKey) {
      healthHistory.push(score);
      if (healthHistory.length > 120) {
        healthHistory.shift();
      }
      lastHistoryKey = historyKey;
    }

    const copilot = getProviderSection(sections, "copilot");
    const codex = getProviderSection(sections, "codex");
    const copilotContent = formatProviderPanel("Copilot", "yellow", copilot);
    const codexContent = formatProviderPanel("Codex", "cyan", codex);

    applyResponsiveLayout(countLines(copilotContent), countLines(codexContent));

    insights.setContent(buildInsightsContent(copilot, codex, healthHistory));
    copilotPanel.setContent(copilotContent);
    codexPanel.setContent(codexContent);
    metrics.setContent(buildTopMetrics(state, sections, activePanel, healthHistory, layoutMode));
    screen.render();
  }

  async function refreshAndPaint() {
    repaint();
    await refresh();
    repaint();
  }

  screen.key(["q", "C-c"], () => {
    screen.destroy();
    process.exit(0);
  });

  screen.key(["r"], () => {
    void refreshAndPaint();
  });

  screen.key(["tab"], () => {
    activePanel = activePanel === "copilot" ? "codex" : "copilot";
    repaint();
  });

  screen.key(["up"], () => {
    focusedBox().scroll(-1);
    screen.render();
  });

  screen.key(["down"], () => {
    focusedBox().scroll(1);
    screen.render();
  });

  screen.key(["pageup"], () => {
    focusedBox().scroll(-10);
    screen.render();
  });

  screen.key(["pagedown"], () => {
    focusedBox().scroll(10);
    screen.render();
  });

  screen.on("resize", () => {
    repaint();
  });

  await refreshAndPaint();
  setInterval(() => {
    void refreshAndPaint();
  }, autoRefreshMs);
}

if (onceMode) {
  await runOnce();
} else {
  await runBlessed();
}
