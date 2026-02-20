import type { Provider } from "../types";

export type SectionStatus = "ok" | "warning" | "error";

export interface ParsedSection {
  name: string;
  lines: string[];
  status: SectionStatus;
}

export interface ProviderSummary {
  provider: Provider;
  section?: ParsedSection;
  avgRemaining: number | null;
}

export function formatClock(value: Date | null): string {
  if (!value) return "never";
  const hh = String(value.getHours()).padStart(2, "0");
  const mm = String(value.getMinutes()).padStart(2, "0");
  const ss = String(value.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function parseSections(content: string): ParsedSection[] {
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

export function getProviderSection(sections: ParsedSection[], providerLabel: string): ParsedSection | undefined {
  const needle = providerLabel.toLowerCase();
  return sections.find((section) => section.name.toLowerCase() === needle);
}

export function extractRemainingPercents(section: ParsedSection | undefined): number[] {
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

export function averageRemaining(section: ParsedSection | undefined): number | null {
  const points = extractRemainingPercents(section);
  if (points.length === 0) return null;
  return Math.round(points.reduce((sum, value) => sum + value, 0) / points.length);
}

export function healthScore(sections: ParsedSection[]): number {
  if (sections.length === 0) return 0;
  let points = 0;
  for (const section of sections) {
    if (section.status === "ok") points += 1;
    if (section.status === "warning") points += 0.5;
  }
  return Math.round((points / sections.length) * 100);
}

export function buildProviderSummaries(providers: Provider[], sections: ParsedSection[]): ProviderSummary[] {
  return providers.map((provider) => {
    const section = getProviderSection(sections, provider.label);
    return {
      provider,
      section,
      avgRemaining: averageRemaining(section),
    };
  });
}

export function statusDot(status: SectionStatus | undefined): string {
  if (status === "ok") return "●";
  if (status === "warning") return "◐";
  if (status === "error") return "●";
  return "○";
}

export function statusLabel(status: SectionStatus | undefined): string {
  if (status === "ok") return "LIVE";
  if (status === "warning") return "PARTIAL";
  if (status === "error") return "ISSUE";
  return "IDLE";
}
