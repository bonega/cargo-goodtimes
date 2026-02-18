import type { BuildGraph } from "../lib/types.ts";

export function useGraph() {
  const graph = (window as any).__GRAPH_DATA__ as BuildGraph | undefined;
  return { graph: graph ?? null, error: graph ? null : "No graph data found" };
}
