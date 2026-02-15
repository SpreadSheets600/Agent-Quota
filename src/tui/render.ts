import type { AppState } from "../types";

const CSI = "\x1b[";
const RESET = "\x1b[0m";

function clearScreen(): string {
  return `${CSI}2J${CSI}H`;
}

function colorForStatus(status: AppState["status"]): string {
  if (status === "ok") return "\x1b[32m";
  if (status === "error") return "\x1b[31m";
  if (status === "loading") return "\x1b[33m";
  return "\x1b[37m";
}

function statusText(state: AppState): string {
  if (state.status === "loading") return "loading";
  if (state.status === "ok") return "ok";
  if (state.status === "error") return "error";
  return "idle";
}

function formatTime(d: Date | null): string {
  if (!d) return "never";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function terminalWidth(): number {
  const width = process.stdout.columns ?? 110;
  return Math.max(80, Math.min(200, width));
}

function line(char: string, width: number): string {
  return char.repeat(Math.max(1, width));
}

function padRight(input: string, width: number): string {
  if (input.length >= width) return input.slice(0, width);
  return `${input}${" ".repeat(width - input.length)}`;
}

function statusBadge(state: AppState): string {
  const text = statusText(state).toUpperCase();
  const color = colorForStatus(state.status);
  return `${color}[ ${text} ]${RESET}`;
}

function formatContent(content: string): string {
  if (!content.trim()) return "";

  const out: string[] = [];
  const lines = content.split("\n");

  for (const raw of lines) {
    if (raw.startsWith("## ")) {
      const name = raw.slice(3).trim();
      out.push("");
      out.push(`\x1b[36m[ ${name} ]${RESET}`);
      out.push(`\x1b[90m${"-".repeat(Math.max(12, name.length + 4))}${RESET}`);
      continue;
    }

    if (raw.startsWith("### ")) {
      out.push(`\x1b[1m${raw.slice(4).trim()}${RESET}`);
      continue;
    }

    if (raw.startsWith("ERROR:")) {
      out.push(`\x1b[31m${raw}${RESET}`);
      continue;
    }

    if (raw.startsWith("Quota        skipped")) {
      out.push(`\x1b[33m${raw}${RESET}`);
      continue;
    }

    if (raw.startsWith("Quota        unavailable")) {
      out.push(`\x1b[31m${raw}${RESET}`);
      continue;
    }

    out.push(raw);
  }

  return out.join("\n").trim();
}

export function render(state: AppState): string {
  const width = terminalWidth();
  const topRule = line("=", width);
  const midRule = line("-", width);
  const title = "\x1b[1mAgent Status TUI\x1b[0m";
  const updated = formatTime(state.lastUpdated);
  const headerLeft = `${title}  ${statusBadge(state)}`;
  const headerRight = `Updated ${updated}`;
  const space = Math.max(1, width - headerLeft.replace(/\x1b\[[0-9;]*m/g, "").length - headerRight.length);
  const header = `${headerLeft}${" ".repeat(space)}${headerRight}`;
  const hints = "Controls: [r] refresh   [q] quit";
  const body = formatContent(state.content);
  const msg = state.message?.trim() ?? "";
  const showMessage = Boolean(msg) && msg !== body;

  return [
    clearScreen(),
    topRule,
    padRight(header, width),
    padRight(hints, width),
    midRule,
    "",
    body || msg,
    "",
    showMessage ? `\x1b[90mMessage: ${msg}${RESET}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
