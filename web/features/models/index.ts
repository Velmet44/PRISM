// Model selection view-model: explicit select + auto-balanced profile
// display with the final selection exposed (Stage 2 scope: explicit
// model select + one auto profile; shared weights via Ollama adapter).

export type AutoProfile = "balanced";

export interface ModelCatalogEntry {
  readonly modelId: string;
  readonly label: string;
}

export interface ModelSelection {
  /** Explicit owner override, or null when the auto profile applies. */
  readonly explicitModelId: string | null;
  readonly autoProfile: AutoProfile;
  /** Effective model after resolution — always exposed. */
  readonly resolvedModelId: string;
  readonly source: "explicit" | "auto";
}

export function resolveModelSelection(
  explicitModelId: string | null,
  autoDefaultModelId: string,
  catalog: readonly ModelCatalogEntry[],
): ModelSelection {
  const known = new Set(catalog.map((entry) => entry.modelId));
  if (explicitModelId !== null && known.has(explicitModelId)) {
    return {
      explicitModelId,
      autoProfile: "balanced",
      resolvedModelId: explicitModelId,
      source: "explicit",
    };
  }
  return {
    explicitModelId: null,
    autoProfile: "balanced",
    resolvedModelId: autoDefaultModelId,
    source: "auto",
  };
}

export function describeModelSelection(selection: ModelSelection): string {
  if (selection.source === "explicit") {
    return `Explicit model ${selection.resolvedModelId} (auto profile balanced not applied).`;
  }
  return `Auto-balanced profile → ${selection.resolvedModelId}.`;
}

export function buildModelsViewModel(
  catalog: readonly ModelCatalogEntry[],
  selection: ModelSelection,
): {
  readonly catalog: readonly ModelCatalogEntry[];
  readonly selection: ModelSelection;
  readonly summary: string;
} {
  return {
    catalog: catalog.map((entry) => ({ ...entry })),
    selection: { ...selection },
    summary: describeModelSelection(selection),
  };
}
