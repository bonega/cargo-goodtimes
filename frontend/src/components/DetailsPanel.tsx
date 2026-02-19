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
  const [highlightIdx, setHighlightIdx] = useState(-1);
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

  // Active edges: original minus removed, plus added.
  const activeEdges = useMemo(() => {
    const edges = graph.edges.filter(
      (e) => !removedEdges.has(`${e.from}|${e.to}`),
    );
    for (const key of addedEdges) {
      const [from, to] = key.split("|");
      edges.push({ from, to, dep_kinds: [] });
    }
    return edges;
  }, [graph.edges, removedEdges, addedEdges]);

  // Nodes that transitively depend on the selected node — adding any of
  // these as a dependency would create a cycle.
  const wouldCycle = useMemo(() => {
    if (!node) return new Set<string>();
    // Build reverse map: dependency -> dependents.
    const dependents = new Map<string, string[]>();
    for (const e of activeEdges) {
      if (!dependents.has(e.to)) dependents.set(e.to, []);
      dependents.get(e.to)!.push(e.from);
    }
    // BFS from selected node following reverse edges.
    const visited = new Set<string>();
    const queue = [node.id];
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const dep of dependents.get(id) ?? []) {
        queue.push(dep);
      }
    }
    return visited;
  }, [node, activeEdges]);

  // All crate names for autocomplete, excluding already-active deps, self,
  // and any node that would create a cycle.
  const suggestions = useMemo(() => {
    if (!node || !addQuery.trim()) return [];
    const activeSet = new Set(activeDeps.map((d) => d.id));
    activeSet.add(node.id);
    const q = addQuery.toLowerCase();
    return Object.values(graph.nodes)
      .filter((n) => !activeSet.has(n.id) && !wouldCycle.has(n.id) && n.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 8);
  }, [node, graph, activeDeps, addQuery, wouldCycle]);

  const handleAddDep = useCallback(
    (depId: string) => {
      if (!node) return;
      onAddEdge(node.id, depId);
      setAddQuery("");
      setShowSuggestions(false);
      setHighlightIdx(-1);
    },
    [node, onAddEdge],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!showSuggestions || suggestions.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIdx((i) => (i + 1) % suggestions.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIdx((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
      } else if (e.key === "Enter" && highlightIdx >= 0) {
        e.preventDefault();
        handleAddDep(suggestions[highlightIdx].id);
      }
    },
    [showSuggestions, suggestions, highlightIdx, handleAddDep],
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
            setHighlightIdx(-1);
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => {
            // Delay to allow click on suggestion.
            setTimeout(() => setShowSuggestions(false), 150);
          }}
        />
        {showSuggestions && suggestions.length > 0 && (
          <ul className="dep-suggestions">
            {suggestions.map((s, i) => (
              <li
                key={s.id}
                className={i === highlightIdx ? "active" : ""}
                onMouseDown={() => handleAddDep(s.id)}
              >
                {s.name}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
