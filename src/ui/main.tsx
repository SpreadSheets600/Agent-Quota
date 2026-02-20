import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./App";

export async function runApp(refreshMs: number): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: true,
  });

  createRoot(renderer).render(<App refreshMs={refreshMs} />);
}
