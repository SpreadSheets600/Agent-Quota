import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Provider, QueryResult } from "../types";

const execFileAsync = promisify(execFile);

function bar(percent: number, width = 24): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const full = Math.round((clamped / 100) * width);
  return `[${"█".repeat(full)}${"·".repeat(width - full)}]`;
}

function parseAmpUsage(output: string): {
  email: string;
  nickname: string;
  freeRemaining: number;
  freeTotal: number;
  replenishRate: string | null;
  bonus: string | null;
  individualCredits: number;
} {
  const lines = output.trim().split("\n");
  const firstLine = lines[0] ?? "";

  const emailMatch = firstLine.match(/Signed in as\s+([^\s]+)\s+\(([^)]+)\)/i);
  if (!emailMatch) {
    throw new Error("Not logged in. Run `amp login` first.");
  }

  const email = emailMatch[1] ?? "unknown";
  const nickname = emailMatch[2] ?? "unknown";

  const freeLine = lines.find((line) => line.includes("Amp Free:")) ?? "";
  const freeMatch = freeLine.match(/Amp Free:\s*\$([\d.]+)\/\$([\d.]+)/i);
  const freeRemaining = freeMatch?.[1] ? Number(freeMatch[1]) : 0;
  const freeTotal = freeMatch?.[2] ? Number(freeMatch[2]) : 0;

  const replenish = freeLine.match(/replenishes\s+\+\$([\d.]+)\/hour/i);
  const replenishRate = replenish?.[1] ? `$${replenish[1]}/hour` : null;

  const bonusMatch = freeLine.match(/\[(.+?)\]/);
  const bonus = bonusMatch?.[1] ?? null;

  const creditsLine = lines.find((line) => line.includes("Individual credits:")) ?? "";
  const creditsMatch = creditsLine.match(/Individual credits:\s*\$([\d.]+)/i);
  const individualCredits = creditsMatch?.[1] ? Number(creditsMatch[1]) : 0;

  return {
    email,
    nickname,
    freeRemaining,
    freeTotal,
    replenishRate,
    bonus,
    individualCredits,
  };
}

function formatAmpOutput(data: ReturnType<typeof parseAmpUsage>): string {
  const lines: string[] = [];
  const percentRemaining =
    data.freeTotal > 0 ? Math.round(Math.max(0, Math.min(100, (data.freeRemaining / data.freeTotal) * 100))) : 0;

  lines.push(`Account      ${data.email}`);
  lines.push(`Profile      ${data.nickname}`);
  lines.push("");
  lines.push(
    `Amp Free     ${bar(percentRemaining)} ${percentRemaining}% remaining ($${data.freeRemaining}/$${data.freeTotal})`,
  );
  if (data.replenishRate) {
    lines.push(`Replenish    ${data.replenishRate}`);
  }
  if (data.bonus) {
    lines.push(`Bonus        ${data.bonus}`);
  }
  lines.push(`Credits      $${data.individualCredits} remaining`);
  return lines.join("\n");
}

async function queryAmpUsage(): Promise<QueryResult> {
  try {
    const { stdout, stderr } = await execFileAsync("amp", ["usage"], {
      timeout: 10000,
      encoding: "utf-8",
    });

    const merged = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
    if (!merged) {
      return {
        success: true,
        output: "Quota        skipped (empty response from `amp usage`)",
      };
    }

    const parsed = parseAmpUsage(merged);
    return {
      success: true,
      output: formatAmpOutput(parsed),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("ENOENT")) {
      return {
        success: true,
        output: "Quota        skipped (Amp CLI not found in PATH)",
      };
    }
    if (/not logged in|login required|unauthorized/i.test(msg)) {
      return {
        success: true,
        output: "Quota        skipped (not logged in, run `amp login`)",
      };
    }
    return {
      success: false,
      error: msg,
    };
  }
}

export const ampProvider: Provider = {
  id: "amp",
  label: "Amp",
  query: queryAmpUsage,
};

