import { ampProvider } from "../providers/amp";
import { antigravityProvider } from "../providers/antigravity";
import { codexProvider } from "../providers/codex";
import { copilotProvider } from "../providers/copilot";
import { droidProvider } from "../providers/droid";
import { geminiProvider } from "../providers/gemini";
import { kimiProvider } from "../providers/kimi";
import { zaiProvider } from "../providers/zai";
import type { Provider } from "../types";

export const providers: Provider[] = [
  copilotProvider,
  codexProvider,
  geminiProvider,
  ampProvider,
  droidProvider,
  kimiProvider,
  zaiProvider,
  antigravityProvider,
];
