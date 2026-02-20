import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { queryProviders } from "../../app/query";
import { buildProviderSummaries, healthScore, parseSections } from "../../app/status-model";
import type { AppState, Provider } from "../../types";

const initialState: AppState = {
  lastUpdated: null,
  status: "idle",
  content: "",
  message: "Press r to refresh.",
};

interface UseStatusDataResult {
  state: AppState;
  sections: ReturnType<typeof parseSections>;
  summaries: ReturnType<typeof buildProviderSummaries>;
  health: number;
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  nextProvider: () => void;
  prevProvider: () => void;
  refreshNow: () => Promise<void>;
}

export function useStatusData(providers: Provider[], refreshMs: number): UseStatusDataResult {
  const [state, setState] = useState<AppState>(initialState);
  const [selectedIndex, setSelectedIndexState] = useState(0);
  const inflight = useRef(false);

  const setSelectedIndex = useCallback(
    (index: number) => {
      if (providers.length === 0) {
        setSelectedIndexState(0);
        return;
      }
      const normalized = ((index % providers.length) + providers.length) % providers.length;
      setSelectedIndexState(normalized);
    },
    [providers.length],
  );

  const nextProvider = useCallback(() => {
    setSelectedIndex((selectedIndex + 1) % Math.max(1, providers.length));
  }, [providers.length, selectedIndex, setSelectedIndex]);

  const prevProvider = useCallback(() => {
    setSelectedIndex((selectedIndex - 1 + Math.max(1, providers.length)) % Math.max(1, providers.length));
  }, [providers.length, selectedIndex, setSelectedIndex]);

  const refreshNow = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;

    setState((current) => ({
      ...current,
      status: "loading",
      message: `Querying ${providers.map((provider) => provider.label).join(", ")}...`,
    }));

    const snapshot = await queryProviders(providers);
    setState(snapshot);
    inflight.current = false;
  }, [providers]);

  useEffect(() => {
    void refreshNow();
    const timer = setInterval(() => {
      void refreshNow();
    }, refreshMs);

    return () => clearInterval(timer);
  }, [refreshMs, refreshNow]);

  const sections = useMemo(() => parseSections(state.content), [state.content]);
  const summaries = useMemo(() => buildProviderSummaries(providers, sections), [providers, sections]);
  const health = useMemo(() => healthScore(sections), [sections]);

  useEffect(() => {
    if (selectedIndex >= providers.length) {
      setSelectedIndex(0);
    }
  }, [providers.length, selectedIndex, setSelectedIndex]);

  return {
    state,
    sections,
    summaries,
    health,
    selectedIndex,
    setSelectedIndex,
    nextProvider,
    prevProvider,
    refreshNow,
  };
}
