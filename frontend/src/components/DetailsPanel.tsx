import { useState, useMemo, useRef, useCallback } from "react";
import type { BuildGraph, CrateNode } from "../lib/types.ts";

interface Props {
  node: CrateNode | null;
  graph: BuildGraph;
  removedEdges: Set<string>;
  addedEdges: Set<string>;
  onRemoveEdge: (from: string, to: string) => void;
  onAddEdge: (from: string, to: string) => void;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function DetailsPanel({ node, graph, removedEdges, addedEdges, onRemoveEdge, onAddEdge }: Props) {
  const [addQuery, setAddQuery] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Current active deps for this node (original minus removed, plus added).
  const activeDeps = useMemo(() => {
    if (!node) return [];
    const fromOriginal = graph.edges
      .filter(
        (e) =>
          e.from === node.id && !removedEdges.has(`${e.from}|${e.to}`),
      )
      .map((e) => e.to);
    const fromAdded = [...addedEdges]
      .filter((key) => key.startsWith(`${node.id}|`))
      .map((key) => key.split("|")[1]);
    const allDepIds = new Set([...fromOriginal, ...fromAdded]);
    return [...allDepIds]
      .map((id) => {
        const depNode = graph.nodes[id];
        return depNode ? { id, name: depNode.name } : null;
      })
      .filter((d): d is { id: string; name: string } => d !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [node, graph, removedEdges, addedEdges]);

  // Removed deps for this node (edges that exist in original but are removed).
  const removedDeps = useMemo(() => {
    if (!node) return [];
    return graph.edges
      .filter(
        (e) =>
          e.from === node.id && removedEdges.has(`${e.from}|${e.to}`),
      )
      .map((e) => {
        const depNode = graph.nodes[e.to];
        return depNode ? { id: e.to, name: depNode.name } : null;
      })
      .filter((d): d is { id: string; name: string } => d !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [node, graph, removedEdges]);

  // All crate names for autocomplete, excluding already-active deps and self.
  const suggestions = useMemo(() => {
    if (!node || !addQuery.trim()) return [];
    const activeSet = new Set(activeDeps.map((d) => d.id));
    activeSet.add(node.id);
    const q = addQuery.toLowerCase();
    return Object.values(graph.nodes)
      .filter((n) => !activeSet.has(n.id) && n.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 8);
  }, [node, graph, activeDeps, addQuery]);

  const handleAddDep = useCallback(
    (depId: string) => {
      if (!node) return;
      onAddEdge(node.id, depId);
      setAddQuery("");
      setShowSuggestions(false);
    },
    [node, onAddEdge],
  );

  const summary = useMemo(() => {
    const nodes = Object.values(graph.nodes);
    const built = nodes.filter((n) => n.duration_ms !== null && !n.fresh);
    const totalCrates = nodes.length;
    const builtCrates = built.length;
    const cachedCrates = nodes.filter((n) => n.fresh).length;

    let totalMs = 0;
    for (const n of nodes) {
      if (n.start_ms !== null && n.duration_ms !== null) {
        totalMs = Math.max(totalMs, n.start_ms + n.duration_ms);
      }
    }

    const longestCrate = built.reduce<{ name: string; ms: number } | null>(
      (best, n) =>
        n.duration_ms! > (best?.ms ?? 0)
          ? { name: n.name, ms: n.duration_ms! }
          : best,
      null,
    );

    const cpLength = graph.critical_path.length;

    return { totalCrates, builtCrates, cachedCrates, totalMs, longestCrate, cpLength };
  }, [graph]);

  if (!node) {
    return (
      <div className="details-panel">
        <h2>Build Summary</h2>
        <dl>
          <dt>Total time</dt>
          <dd>{formatDuration(summary.totalMs)}</dd>
          <dt>Crates</dt>
          <dd>{summary.totalCrates} ({summary.builtCrates} built, {summary.cachedCrates} cached)</dd>
          <dt>Critical path</dt>
          <dd>{summary.cpLength} crates</dd>
          {summary.longestCrate && (
            <>
              <dt>Slowest crate</dt>
              <dd>{summary.longestCrate.name} ({formatDuration(summary.longestCrate.ms)})</dd>
            </>
          )}
        </dl>
        <p className="details-hint">Click a bar to see crate details</p>
      </div>
    );
  }

  return (
    <div className="details-panel">
      <h2>{node.name}</h2>
      <dl>
        <dt>Version</dt>
        <dd>{node.version}</dd>
        <dt>Compile time</dt>
        <dd>{node.fresh ? "cached" : formatDuration(node.duration_ms)}</dd>
        {node.start_ms !== null && (
          <>
            <dt>Started at</dt>
            <dd>{formatDuration(node.start_ms)} into build</dd>
          </>
        )}
        <dt>Type</dt>
        <dd>{node.is_workspace_member ? "Workspace member" : "Dependency"}</dd>
        {node.features.length > 0 && (
          <>
            <dt>Features</dt>
            <dd>{node.features.join(", ")}</dd>
          </>
        )}
      </dl>

      <h3>Dependencies ({activeDeps.length})</h3>
      <ul className="dep-list">
        {activeDeps.map((dep) => (
          <li key={dep.id}>
            <span className="dep-name">{dep.name}</span>
            <button
              className="dep-remove"
              onClick={() => onRemoveEdge(node.id, dep.id)}
              title="Remove dependency (what-if)"
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      {removedDeps.length > 0 && (
        <>
          <h3 className="removed-heading">
            Removed ({removedDeps.length})
          </h3>
          <ul className="dep-list removed">
            {removedDeps.map((dep) => (
              <li key={dep.id}>
                <span className="dep-name">{dep.name}</span>
                <button
                  className="dep-restore"
                  onClick={() => onAddEdge(node.id, dep.id)}
                  title="Restore dependency"
                >
                  +
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="dep-add">
        <input
          ref={inputRef}
          type="text"
          placeholder="Add dependency..."
          value={addQuery}
          onChange={(e) => {
            setAddQuery(e.target.value);
            setShowSuggestions(true);
          }}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => {
            // Delay to allow click on suggestion.
            setTimeout(() => setShowSuggestions(false), 150);
          }}
        />
        {showSuggestions && suggestions.length > 0 && (
          <ul className="dep-suggestions">
            {suggestions.map((s) => (
              <li key={s.id} onMouseDown={() => handleAddDep(s.id)}>
                {s.name}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
