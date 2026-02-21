import { useMemo } from "react";

function parseEdgeParam(value: string, validNodeIds: Set<string>): Set<string> {
  const edges = new Set<string>();
  if (!value) return edges;
  for (const pair of value.split(",")) {
    const [from, to] = pair.split("~");
    if (from && to && validNodeIds.has(from) && validNodeIds.has(to)) {
      edges.add(`${from}|${to}`);
    }
  }
  return edges;
}

function serializeEdges(edges: Set<string>): string {
  return [...edges]
    .map((key) => key.replace("|", "~"))
    .sort()
    .join(",");
}

/** Serialize current state to the URL hash via history.replaceState. */
export function syncToHash(
  selectedNodeId: string | null,
  removedEdges: Set<string>,
  addedEdges: Set<string>,
) {
  const parts: string[] = [];
  if (selectedNodeId) parts.push(`sel=${selectedNodeId}`);
  if (removedEdges.size > 0) parts.push(`rm=${serializeEdges(removedEdges)}`);
  if (addedEdges.size > 0) parts.push(`add=${serializeEdges(addedEdges)}`);

  const hash = parts.join("&");
  const newUrl = hash
    ? `${window.location.pathname}${window.location.search}#${hash}`
    : window.location.pathname + window.location.search;
  history.replaceState(null, "", newUrl);
}

/** Parse the URL hash on mount into initial state, validating against the graph. */
export function useHashState(validNodeIds: Set<string>) {
  return useMemo(() => {
    const hash = window.location.hash.slice(1);
    if (!hash) {
      return {
        selectedNodeId: null as string | null,
        removedEdges: new Set<string>(),
        addedEdges: new Set<string>(),
      };
    }

    const params = new URLSearchParams(hash);
    const sel = params.get("sel");

    return {
      selectedNodeId: sel && validNodeIds.has(sel) ? sel : null,
      removedEdges: parseEdgeParam(params.get("rm") ?? "", validNodeIds),
      addedEdges: parseEdgeParam(params.get("add") ?? "", validNodeIds),
    };
  }, [validNodeIds]);
}
