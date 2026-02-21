import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { DetailsPanel } from "./components/DetailsPanel.tsx";
import { GraphView } from "./components/GraphView.tsx";
import { useGraph } from "./hooks/useGraph.ts";
import { syncToHash, useHashState } from "./hooks/useHashState.ts";
import type { CrateNode } from "./lib/types.ts";

export default function App() {
  const { graph, error } = useGraph();

  const validNodeIds = useMemo(
    () => new Set(graph ? Object.keys(graph.nodes) : []),
    [graph],
  );

  const initialState = useHashState(validNodeIds);

  const [selectedNode, setSelectedNode] = useState<CrateNode | null>(() => {
    if (initialState.selectedNodeId && graph) {
      return graph.nodes[initialState.selectedNodeId] ?? null;
    }
    return null;
  });
  const [removedEdges, setRemovedEdges] = useState(
    () => initialState.removedEdges,
  );
  const [addedEdges, setAddedEdges] = useState(() => initialState.addedEdges);
  const [previewOriginal, setPreviewOriginal] = useState(false);

  useEffect(() => {
    syncToHash(selectedNode?.id ?? null, removedEdges, addedEdges);
  }, [selectedNode, removedEdges, addedEdges]);

  const [modifiedTotalMs, setModifiedTotalMs] = useState<number | null>(null);
  const hasChanges = removedEdges.size > 0 || addedEdges.size > 0;

  const originalTotalMs = useMemo(() => {
    if (!graph) return 0;
    let max = 0;
    for (const node of Object.values(graph.nodes)) {
      if (node.start_ms !== null && node.duration_ms !== null) {
        max = Math.max(max, node.start_ms + node.duration_ms);
      }
    }
    return max;
  }, [graph]);

  const handleTotalMsChange = useCallback((totalMs: number) => {
    setModifiedTotalMs(totalMs);
  }, []);

  const handleRemoveEdge = useCallback((from: string, to: string) => {
    const key = `${from}|${to}`;
    setAddedEdges((prev) => {
      if (prev.has(key)) {
        const next = new Set(prev);
        next.delete(key);
        return next;
      }
      return prev;
    });
    setRemovedEdges((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, []);

  const handleAddEdge = useCallback((from: string, to: string) => {
    const key = `${from}|${to}`;
    setRemovedEdges((prev) => {
      if (prev.has(key)) {
        const next = new Set(prev);
        next.delete(key);
        return next;
      }
      return prev;
    });
    setAddedEdges((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, []);

  const handleResetEdges = useCallback(() => {
    setRemovedEdges(new Set());
    setAddedEdges(new Set());
  }, []);

  if (error) return <div className="error">Error: {error}</div>;
  if (!graph) return <div className="loading">Loading dependency graph…</div>;

  return (
    <div className="app">
      <main>
        <div
          className="graph-container"
          style={hasChanges ? { paddingBottom: "3rem" } : undefined}
        >
          <GraphView
            graph={graph}
            onNodeSelect={setSelectedNode}
            removedEdges={removedEdges}
            addedEdges={addedEdges}
            onRemoveEdge={handleRemoveEdge}
            previewOriginal={previewOriginal}
            onTotalMsChange={handleTotalMsChange}
            initialSelectedId={initialState.selectedNodeId}
          />
        </div>
        <aside>
          <DetailsPanel
            node={selectedNode}
            graph={graph}
            removedEdges={removedEdges}
            addedEdges={addedEdges}
            onRemoveEdge={handleRemoveEdge}
            onAddEdge={handleAddEdge}
          />
        </aside>
      </main>
      {hasChanges && (
        <div className="bottom-bar">
          <span className="change-summary">
            {removedEdges.size > 0 && `${removedEdges.size} removed`}
            {removedEdges.size > 0 && addedEdges.size > 0 && ", "}
            {addedEdges.size > 0 && `${addedEdges.size} added`}
          </span>
          {modifiedTotalMs !== null &&
            (() => {
              const deltaMs = modifiedTotalMs - originalTotalMs;
              if (Math.abs(deltaMs) < 1) return null;
              const absSec = (Math.abs(deltaMs) / 1000).toFixed(1);
              const decreased = deltaMs < 0;
              return (
                <span
                  className={`critical-path-delta ${decreased ? "decreased" : "increased"}`}
                  style={{ visibility: previewOriginal ? "hidden" : "visible" }}
                >
                  Critical path {decreased ? "decreased" : "increased"} by{" "}
                  {absSec}s
                </span>
              );
            })()}
          <button
            type="button"
            className="btn-compare"
            onMouseEnter={() => setPreviewOriginal(true)}
            onMouseLeave={() => setPreviewOriginal(false)}
          >
            Show Original
          </button>
          <button
            type="button"
            className="btn-reset"
            onClick={handleResetEdges}
          >
            Reset
          </button>
        </div>
      )}
      <span className="timeline-legend">
        <span className="legend-swatch critical" />
        critical path
      </span>
    </div>
  );
}
