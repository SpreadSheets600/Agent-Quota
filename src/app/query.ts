import type { AppState, Provider } from "../types";

export interface QuerySnapshot extends AppState {}

export async function queryProviders(providers: Provider[]): Promise<QuerySnapshot> {
  try {
    const results = await Promise.all(
      providers.map(async (provider) => ({ provider, result: await provider.query() })),
    );

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

    return {
      lastUpdated: new Date(),
      status: failures.length === 0 ? "ok" : "error",
      content: sections.join("\n\n"),
      message: failures.length === 0 ? "" : `${failures.length} provider(s) failed.`,
    };
  } catch (error) {
    return {
      lastUpdated: null,
      status: "error",
      content: "",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
