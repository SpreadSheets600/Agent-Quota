import type { QuerySnapshot } from "./query";
import { formatClock, healthScore, parseSections, statusLabel } from "./status-model";

export function renderOnce(snapshot: QuerySnapshot): string {
  const sections = parseSections(snapshot.content);
  const score = healthScore(sections);

  const header = [
    "Quota Status",
    `state=${snapshot.status.toUpperCase()}`,
    `updated=${formatClock(snapshot.lastUpdated)}`,
    `health=${score}%`,
  ].join(" | ");

  const summary = sections
    .map((section) => `${section.name}: ${statusLabel(section.status)}`)
    .join("\n");

  return [header, "", summary, "", snapshot.content || snapshot.message].filter(Boolean).join("\n");
}
