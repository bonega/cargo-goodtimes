import { useMemo, useRef, useCallback, useState, useLayoutEffect, useEffect } from "react";
import type { BuildGraph, CrateNode } from "../lib/types.ts";

const ROW_HEIGHT = 28;
const ROW_GAP = 2;
const PADDING_LEFT = 20;
const PADDING_RIGHT = 20;
const HEADER_HEIGHT = 32;

/** Interpolate all numeric values between two SVG path strings. */
function interpolatePath(from: string, to: string, t: number): string {
  const fromNums = from.match(/-?[\d.]+/g)?.map(Number);
  const toNums = to.match(/-?[\d.]+/g)?.map(Number);
  if (!fromNums || !toNums || fromNums.length !== toNums.length) return to;
  let idx = 0;
  return to.replace(/-?[\d.]+/g, () => {
    const v = fromNums[idx] + (toNums[idx] - fromNums[idx]) * t;
    idx++;
    return v.toFixed(4);
  });
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

/**
 * Trace a path progressively point-by-point, like a pen following a maze.
 * At t=0 the path is collapsed to (startX, startY).
 * At t=1 the path is fully drawn.
 * Points are revealed sequentially — each point moves from the previous
 * point's final position to its own, keeping undrawn points at the tip.
 */
function traceGrowPath(startX: number, startY: number, path: string, t: number): string {
  const nums = path.match(/-?[\d.]+/g)?.map(Number);
  if (!nums || nums.length < 2) return path;
  if (t >= 1) return path;

  const nPts = nums.length / 2;
  const result = new Array(nums.length);

  if (t <= 0) {
    for (let i = 0; i < nums.length; i++) result[i] = i % 2 === 0 ? startX : startY;
  } else {
    const progress = t * (nPts - 1);
    const done = Math.floor(progress);
    const frac = progress - done;

    // Completed points: at final position.
    for (let i = 0; i <= done; i++) {
      result[i * 2] = nums[i * 2];
      result[i * 2 + 1] = nums[i * 2 + 1];
    }

    // Tip point: interpolating from previous point toward its final.
    if (done + 1 < nPts) {
      const tipIdx = done + 1;
      const prevX = nums[done * 2];
      const prevY = nums[done * 2 + 1];
      const tipX = prevX + (nums[tipIdx * 2] - prevX) * frac;
      const tipY = prevY + (nums[tipIdx * 2 + 1] - prevY) * frac;
      result[tipIdx * 2] = tipX;
      result[tipIdx * 2 + 1] = tipY;

      // Remaining points: collapsed to the tip.
      for (let i = tipIdx + 1; i < nPts; i++) {
        result[i * 2] = tipX;
        result[i * 2 + 1] = tipY;
      }
    }
  }

  let idx = 0;
  return path.replace(/-?[\d.]+/g, () => result[idx++].toFixed(4));
}

/** Build a collapsed path where all points sit at (x, y). */
function collapsedPath(x: string, y: string): string {
  return (
    `M ${x} ${y} L ${x} ${y} Q ${x} ${y} ${x} ${y} ` +
    `L ${x} ${y} Q ${x} ${y} ${x} ${y} L ${x} ${y}`
  );
}

interface Props {
  graph: BuildGraph;
  onNodeSelect: (node: CrateNode | null) => void;
  removedEdges: Set<string>;
  addedEdges: Set<string>;
  onRemoveEdge: (from: string, to: string) => void;
  previewOriginal: boolean;
  onTotalMsChange?: (totalMs: number) => void;
}

// Stable empty set reference to avoid infinite re-render loops when
// previewOriginal is true (new Set() each render would destabilize all memos).
const EMPTY_STRING_SET: Set<string> = new Set();

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// Colors mirroring CSS custom properties (used in inline SVG attributes where var() is unavailable).
const COLOR_ACCENT = "#6c7be9";
const COLOR_CRITICAL = "#e8954a";
const COLOR_LINE_DEP = "#6aadda";
const COLOR_LINE_DEPN = "#d9944a";

/**
 * Recompute start times by keeping original times and adjusting
 * crates affected by edge changes, propagating forward.
 * - Removed edges can make crates start earlier.
 * - Added edges can make crates start later.
 */
function recomputeStartTimes(
  nodes: Record<string, CrateNode>,
  activeEdges: { from: string; to: string }[],
  originalEdges: { from: string; to: string }[],
  removedEdges: Set<string>,
): Map<string, number> {
  // Build active dep and dependent maps.
  const activeDeps = new Map<string, string[]>();
  const activeDependents = new Map<string, string[]>();
  for (const edge of activeEdges) {
    if (!activeDeps.has(edge.from)) activeDeps.set(edge.from, []);
    activeDeps.get(edge.from)!.push(edge.to);
    if (!activeDependents.has(edge.to)) activeDependents.set(edge.to, []);
    activeDependents.get(edge.to)!.push(edge.from);
  }

  // Initialize all crates with their original start times.
  const startTimes = new Map<string, number>();
  for (const [id, node] of Object.entries(nodes)) {
    startTimes.set(id, node.start_ms ?? 0);
  }

  // Find all directly affected crates (lost or gained a dependency).
  const affected = new Set<string>();
  for (const key of removedEdges) {
    affected.add(key.split("|")[0]);
  }
  // Also check crates that gained edges (from addedEdges).
  const originalEdgeSet = new Set(
    originalEdges.map((e) => `${e.from}|${e.to}`),
  );
  for (const edge of activeEdges) {
    const key = `${edge.from}|${edge.to}`;
    if (!originalEdgeSet.has(key)) {
      affected.add(edge.from);
    }
  }

  // Seed the queue: recompute start for directly affected crates.
  const queue: string[] = [];
  for (const crateId of affected) {
    const node = nodes[crateId];
    if (!node || node.start_ms === null || node.duration_ms === null) continue;

    const myDeps = activeDeps.get(crateId) ?? [];
    let maxDepEnd = 0;
    for (const depId of myDeps) {
      const depNode = nodes[depId];
      if (!depNode || depNode.duration_ms === null) continue;
      maxDepEnd = Math.max(maxDepEnd, startTimes.get(depId)! + depNode.duration_ms);
    }

    const current = startTimes.get(crateId)!;
    if (maxDepEnd !== current) {
      startTimes.set(crateId, maxDepEnd);
      queue.push(crateId);
    }
  }

  // Propagate changes forward through dependents.
  // Guard against cycles: each node is processed at most once.
  const visited = new Set<string>();
  while (queue.length > 0) {
    const crateId = queue.shift()!;
    if (visited.has(crateId)) continue;
    visited.add(crateId);
    const depnIds = activeDependents.get(crateId) ?? [];
    for (const depnId of depnIds) {
      if (visited.has(depnId)) continue;
      const depnNode = nodes[depnId];
      if (!depnNode || depnNode.duration_ms === null) continue;

      const depnDeps = activeDeps.get(depnId) ?? [];
      let maxDepEnd = 0;
      for (const depId of depnDeps) {
        const depNode = nodes[depId];
        if (!depNode || depNode.duration_ms === null) continue;
        maxDepEnd = Math.max(maxDepEnd, startTimes.get(depId)! + depNode.duration_ms);
      }

      const current = startTimes.get(depnId)!;
      if (maxDepEnd !== current) {
        startTimes.set(depnId, maxDepEnd);
        queue.push(depnId);
      }
    }
  }

  return startTimes;
}

/** Compute critical path (longest accumulated duration path) for given edges. */
function recomputeCriticalPath(
  nodes: Record<string, CrateNode>,
  edges: { from: string; to: string }[],
): string[] {
  const depsMap = new Map<string, string[]>();
  for (const edge of edges) {
    if (!depsMap.has(edge.from)) depsMap.set(edge.from, []);
    depsMap.get(edge.from)!.push(edge.to);
  }

  const dp = new Map<string, number>();
  const visiting = new Set<string>();

  function visit(id: string): number {
    if (dp.has(id)) return dp.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);

    const duration = nodes[id]?.duration_ms ?? 0;
    let maxDepPath = 0;
    const myDeps = depsMap.get(id);
    if (myDeps) {
      for (const depId of myDeps) {
        maxDepPath = Math.max(maxDepPath, visit(depId));
      }
    }
    const result = duration + maxDepPath;
    dp.set(id, result);
    return result;
  }

  for (const id of Object.keys(nodes)) visit(id);

  // Find node with longest path, trace back.
  let maxId = "";
  let maxVal = 0;
  for (const [id, val] of dp) {
    if (val > maxVal) { maxVal = val; maxId = id; }
  }

  const path: string[] = [];
  let current = maxId;
  while (current) {
    path.push(current);
    const myDeps = depsMap.get(current);
    if (!myDeps || myDeps.length === 0) break;
    let bestDep = "";
    let bestVal = -1;
    for (const depId of myDeps) {
      const val = dp.get(depId) ?? 0;
      if (val > bestVal) { bestVal = val; bestDep = depId; }
    }
    if (bestDep === "") break;
    current = bestDep;
  }

  return path;
}

interface TimelineEntry {
  node: CrateNode;
  startMs: number;
  durationMs: number;
  isCritical: boolean;
}

export function GraphView({ graph, onNodeSelect, removedEdges, addedEdges, onRemoveEdge, previewOriginal, onTotalMsChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // When previewing original, use unmodified edges.
  const effectiveRemoved = previewOriginal ? EMPTY_STRING_SET : removedEdges;
  const effectiveAdded = previewOriginal ? EMPTY_STRING_SET : addedEdges;

  // Active edges = original edges minus removed ones, plus added ones.
  const activeEdges = useMemo(() => {
    const filtered = effectiveRemoved.size === 0
      ? graph.edges
      : graph.edges.filter((e) => !effectiveRemoved.has(`${e.from}|${e.to}`));
    if (effectiveAdded.size === 0) return filtered;
    const extra = [...effectiveAdded].map((key) => {
      const [from, to] = key.split("|");
      return { from, to, dep_kinds: ["normal"] };
    });
    return [...filtered, ...extra];
  }, [graph.edges, effectiveRemoved, effectiveAdded]);

  // Build dependency maps from active edges.
  const { deps, dependents } = useMemo(() => {
    const deps = new Map<string, Set<string>>();
    const dependents = new Map<string, Set<string>>();
    for (const edge of activeEdges) {
      if (!deps.has(edge.from)) deps.set(edge.from, new Set());
      deps.get(edge.from)!.add(edge.to);
      if (!dependents.has(edge.to)) dependents.set(edge.to, new Set());
      dependents.get(edge.to)!.add(edge.from);
    }
    return { deps, dependents };
  }, [activeEdges]);

  const { entries, totalMs, criticalPath } = useMemo(() => {
    let startTimeMap: Map<string, number> | null = null;
    let criticalPath = graph.critical_path;

    const hasEdgeChanges = effectiveRemoved.size > 0 || effectiveAdded.size > 0;
    if (hasEdgeChanges) {
      startTimeMap = recomputeStartTimes(graph.nodes, activeEdges, graph.edges, effectiveRemoved);
      criticalPath = recomputeCriticalPath(graph.nodes, activeEdges);
    }

    const criticalSet = new Set(criticalPath);

    const entries: TimelineEntry[] = Object.values(graph.nodes)
      .filter((n) => n.duration_ms !== null && n.start_ms !== null)
      .map((n) => ({
        node: n,
        startMs: startTimeMap?.get(n.id) ?? n.start_ms!,
        durationMs: n.duration_ms!,
        isCritical: criticalSet.has(n.id),
      }))
      .sort((a, b) => a.startMs - b.startMs || b.durationMs - a.durationMs);

    const totalMs = entries.reduce(
      (max, e) => Math.max(max, e.startMs + e.durationMs),
      0,
    );

    return { entries, totalMs, criticalPath };
  }, [graph, activeEdges, effectiveRemoved, effectiveAdded]);

  // Report totalMs changes to parent (skip during preview to avoid layout thrash).
  useEffect(() => {
    if (!previewOriginal) {
      onTotalMsChange?.(totalMs);
    }
  }, [totalMs, onTotalMsChange, previewOriginal]);

  // Map crate ID -> row index for positioning lines.
  const rowIndex = useMemo(() => {
    const map = new Map<string, number>();
    entries.forEach((e, i) => map.set(e.node.id, i));
    return map;
  }, [entries]);

  // SVG paths for critical path edges (always visible).
  const criticalPathLines = useMemo(() => {
    const lines: { key: string; d: string }[] = [];
    if (criticalPath.length < 2 || totalMs === 0) return lines;

    const rowCenterY = (row: number) =>
      HEADER_HEIGHT + row * (ROW_HEIGHT + ROW_GAP) + ROW_HEIGHT / 2;
    const barStartPct = (e: TimelineEntry) => (e.startMs / totalMs) * 100;

    const RY = 6;
    const RX = 0.8;

    for (let i = 0; i < criticalPath.length - 1; i++) {
      const fromId = criticalPath[i];
      const toId = criticalPath[i + 1];
      const fromRow = rowIndex.get(fromId);
      const toRow = rowIndex.get(toId);
      if (fromRow === undefined || toRow === undefined) continue;

      const fromEntry = entries[fromRow];
      const toEntry = entries[toRow];
      const x1 = barStartPct(fromEntry);
      const x2 = barStartPct(toEntry);
      const y1 = rowCenterY(fromRow);
      const y2 = rowCenterY(toRow);
      const midX = Math.max(Math.min(x1, x2) - 1.5, 0.5);

      const dy = y2 - y1;
      const signDy = dy > 0 ? 1 : dy < 0 ? -1 : 0;
      const ry = signDy === 0 ? 0 : Math.min(Math.abs(dy) / 2, RY) * signDy;
      const dx1 = midX - x1;
      const signDx1 = dx1 > 0 ? 1 : dx1 < 0 ? -1 : 0;
      const rx1 = signDx1 === 0 ? 0 : Math.min(Math.abs(dx1) / 2, RX) * signDx1;
      const dx2 = x2 - midX;
      const signDx2 = dx2 > 0 ? 1 : dx2 < 0 ? -1 : 0;
      const rx2 = signDx2 === 0 ? 0 : Math.min(Math.abs(dx2) / 2, RX) * signDx2;

      const d =
        `M ${x1} ${y1} ` +
        `L ${midX - rx1} ${y1} ` +
        `Q ${midX} ${y1} ${midX} ${y1 + ry} ` +
        `L ${midX} ${y2 - ry} ` +
        `Q ${midX} ${y2} ${midX + rx2} ${y2} ` +
        `L ${x2} ${y2}`;

      lines.push({ key: `cp|${fromId}|${toId}`, d });
    }
    return lines;
  }, [criticalPath, entries, rowIndex, totalMs]);

  // Deps of the selected crate (for showing X buttons).
  const selectedDeps = useMemo(() => {
    if (!selectedId) return null;
    return deps.get(selectedId) ?? null;
  }, [selectedId, deps]);

  // When selected, lock dep lines to the selected crate; otherwise use hover.
  const lineTargetId = selectedId ?? hoveredId;

  // Compute SVG orthogonal step paths for the target crate's dependencies,
  // keyed by relationship for stable animations.
  const depPathMap = useMemo(() => {
    const map = new Map<string, { d: string; color: string }>();
    if (!lineTargetId || totalMs === 0) return map;
    const srcRow = rowIndex.get(lineTargetId);
    if (srcRow === undefined) return map;
    const srcEntry = entries[srcRow];

    const rowCenterY = (row: number) =>
      HEADER_HEIGHT + row * (ROW_HEIGHT + ROW_GAP) + ROW_HEIGHT / 2;

    const barStartPct = (e: TimelineEntry) => (e.startMs / totalMs) * 100;

    const srcY = rowCenterY(srcRow);

    const RY = 6;
    const RX = 0.8;

    function stepPath(
      x1: number, y1: number,
      x2: number, y2: number,
      midX: number,
    ): string {
      // Always produce M L Q L Q L structure for consistent CSS d interpolation.
      const dy = y2 - y1;
      const signDy = dy > 0 ? 1 : dy < 0 ? -1 : 0;
      const ry = signDy === 0 ? 0 : Math.min(Math.abs(dy) / 2, RY) * signDy;

      const dx1 = midX - x1;
      const signDx1 = dx1 > 0 ? 1 : dx1 < 0 ? -1 : 0;
      const rx1 = signDx1 === 0 ? 0 : Math.min(Math.abs(dx1) / 2, RX) * signDx1;

      const dx2 = x2 - midX;
      const signDx2 = dx2 > 0 ? 1 : dx2 < 0 ? -1 : 0;
      const rx2 = signDx2 === 0 ? 0 : Math.min(Math.abs(dx2) / 2, RX) * signDx2;

      return (
        `M ${x1} ${y1} ` +
        `L ${midX - rx1} ${y1} ` +
        `Q ${midX} ${y1} ${midX} ${y1 + ry} ` +
        `L ${midX} ${y2 - ry} ` +
        `Q ${midX} ${y2} ${midX + rx2} ${y2} ` +
        `L ${x2} ${y2}`
      );
    }

    const depSet = deps.get(lineTargetId);
    if (depSet) {
      for (const depId of depSet) {
        const depRow = rowIndex.get(depId);
        if (depRow === undefined) continue;
        const depEntry = entries[depRow];
        const x1 = barStartPct(srcEntry);
        const x2 = barStartPct(depEntry);
        const y2 = rowCenterY(depRow);
        const midX = Math.max(Math.min(x1, x2) - 1.5, 0.5);
        map.set(`dep|${depId}`, {
          d: stepPath(x1, srcY, x2, y2, midX),
          color: COLOR_LINE_DEP,
        });
      }
    }

    const depnSet = dependents.get(lineTargetId);
    if (depnSet) {
      for (const depnId of depnSet) {
        const depnRow = rowIndex.get(depnId);
        if (depnRow === undefined) continue;
        const depnEntry = entries[depnRow];
        const x1 = barStartPct(srcEntry);
        const x2 = barStartPct(depnEntry);
        const y2 = rowCenterY(depnRow);
        const midX = Math.max(Math.min(x1, x2) - 1.5, 0.5);
        map.set(`depn|${depnId}`, {
          d: stepPath(x1, srcY, x2, y2, midX),
          color: COLOR_LINE_DEPN,
        });
      }
    }

    return map;
  }, [lineTargetId, entries, rowIndex, deps, dependents, totalMs]);

  // Animation state for dependency lines.
  const svgRef = useRef<SVGSVGElement>(null);
  const prevLineTargetRef = useRef<string | null>(null);
  const prevPathDataRef = useRef(new Map<string, string>());
  const animFrameRef = useRef<number>(0);
  // Animation state for critical path lines.
  const prevCriticalPathDataRef = useRef(new Map<string, string>());
  const criticalAnimFrameRef = useRef<number>(0);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [exitingPaths, setExitingPaths] = useState(
    new Map<string, { d: string; color: string }>(),
  );

  // FLIP animation for bars, header ticks, and grid lines.
  const barRectsRef = useRef(new Map<string, DOMRect>());
  const tickRectsRef = useRef(new Map<string, DOMRect>());
  const gridRectsRef = useRef(new Map<string, DOMRect>());
  const ANIM_OPTS: KeyframeAnimationOptions = {
    duration: 400,
    easing: "cubic-bezier(0.4, 0, 0.2, 1)",
  };

  useLayoutEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const bars = chart.querySelectorAll<HTMLElement>(".timeline-bar[data-id]");
    const ticks = chart.querySelectorAll<HTMLElement>(".timeline-tick[data-ms]");
    const grids = chart.querySelectorAll<HTMLElement>(".timeline-gridline[data-grid-ms]");

    // Capture all new rects BEFORE starting any animations.
    // getBoundingClientRect reflects WAAPI transforms, so reading after
    // animate() would store the animated (old) position, breaking the
    // reverse FLIP.
    const newBarRects = new Map<string, DOMRect>();
    for (const bar of bars) {
      newBarRects.set(bar.dataset.id!, bar.getBoundingClientRect());
    }
    const newTickRects = new Map<string, DOMRect>();
    for (const tick of ticks) {
      newTickRects.set(tick.dataset.ms!, tick.getBoundingClientRect());
    }
    const newGridRects = new Map<string, DOMRect>();
    for (const grid of grids) {
      newGridRects.set(grid.dataset.gridMs!, grid.getBoundingClientRect());
    }

    // --- Bar FLIP (position + width) ---
    const prevBars = barRectsRef.current;
    for (const bar of bars) {
      const id = bar.dataset.id!;
      const oldRect = prevBars.get(id);
      if (!oldRect) continue;

      const newRect = newBarRects.get(id)!;
      const dx = oldRect.left - newRect.left;
      const dy = oldRect.top - newRect.top;
      const dw = oldRect.width - newRect.width;

      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5 || Math.abs(dw) > 0.5) {
        const from: Keyframe = { transform: `translate(${dx}px, ${dy}px)` };
        const to: Keyframe = { transform: "translate(0, 0)" };
        if (Math.abs(dw) > 0.5) {
          from.width = `${oldRect.width}px`;
          to.width = `${newRect.width}px`;
        }
        bar.animate([from, to], ANIM_OPTS);
      }
    }
    barRectsRef.current = newBarRects;

    // --- Header tick + grid line FLIP ---
    function flipHorizontal(
      els: NodeListOf<HTMLElement>,
      attr: string,
      prevRects: Map<string, DOMRect>,
      newRects: Map<string, DOMRect>,
    ) {
      for (const el of els) {
        const key = el.dataset[attr]!;
        const oldRect = prevRects.get(key);
        if (!oldRect) {
          el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: "ease" });
          continue;
        }
        const newRect = newRects.get(key)!;
        const dx = oldRect.left - newRect.left;
        if (Math.abs(dx) > 0.5) {
          el.animate(
            [{ transform: `translateX(${dx}px)` }, { transform: "translateX(0)" }],
            ANIM_OPTS,
          );
        }
      }
    }

    flipHorizontal(ticks, "ms", tickRectsRef.current, newTickRects);
    tickRectsRef.current = newTickRects;

    flipHorizontal(grids, "gridMs", gridRectsRef.current, newGridRects);
    gridRectsRef.current = newGridRects;
  }, [entries, totalMs]);

  // Line animation: exit tracking + path interpolation via rAF.
  // useLayoutEffect runs after DOM update but before paint, so we can
  // reset path `d` attributes to old values and animate to new ones
  // without any visible flash.
  useLayoutEffect(() => {
    const sameTarget = prevLineTargetRef.current === lineTargetId;
    const prev = prevPathDataRef.current;

    // --- Exit tracking: detect removed lines ---
    if (sameTarget && prev.size > 0) {
      const exiting = new Map<string, { d: string; color: string }>();
      for (const [key, d] of prev) {
        if (!depPathMap.has(key)) {
          const color = key.startsWith("dep|") ? COLOR_LINE_DEP : COLOR_LINE_DEPN;
          exiting.set(key, { d, color });
        }
      }
      if (exiting.size > 0) {
        setExitingPaths(exiting);
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = setTimeout(() => setExitingPaths(new Map()), 500);
      } else {
        setExitingPaths((prev) => (prev.size > 0 ? new Map() : prev));
      }
    } else {
      setExitingPaths((prev) => (prev.size > 0 ? new Map() : prev));
    }

    // --- Path position animation via rAF ---
    cancelAnimationFrame(animFrameRef.current);

    if (sameTarget && svgRef.current) {
      const svg = svgRef.current;
      const toAnimate: { el: SVGPathElement; from: string; to: string }[] = [];

      for (const [key, path] of depPathMap) {
        const oldD = prev.get(key);
        const el = svg.querySelector<SVGPathElement>(`.dep-line[data-key="${key}"]`);
        if (!el) continue;

        if (oldD && oldD !== path.d) {
          // Existing line moved — interpolate from old to new.
          toAnimate.push({ el, from: oldD, to: path.d });
          el.setAttribute("d", oldD);
        } else if (!oldD) {
          // New line (e.g. restored dep) — grow from source point.
          const m = path.d.match(/^M\s+([\d.-]+)\s+([\d.-]+)/);
          if (m) {
            const collapsed = collapsedPath(m[1], m[2]);
            toAnimate.push({ el, from: collapsed, to: path.d });
            el.setAttribute("d", collapsed);
          }
        }
      }

      if (toAnimate.length > 0) {
        const duration = 400;
        const start = performance.now();

        const animate = (now: number) => {
          const t = Math.min((now - start) / duration, 1);
          const eased = easeInOutQuad(t);
          for (const { el, from, to } of toAnimate) {
            el.setAttribute("d", interpolatePath(from, to, eased));
          }
          if (t < 1) {
            animFrameRef.current = requestAnimationFrame(animate);
          }
        };

        animFrameRef.current = requestAnimationFrame(animate);
      }
    }

    // Update refs for next render.
    prevLineTargetRef.current = lineTargetId;
    prevPathDataRef.current = new Map(
      [...depPathMap.entries()].map(([k, v]) => [k, v.d]),
    );

    return () => cancelAnimationFrame(animFrameRef.current);
  }, [depPathMap, lineTargetId]);

  // Critical path line animation via rAF.
  const cpExitAnimFrameRef = useRef<number>(0);
  const [cpExitingPaths, setCpExitingPaths] = useState(
    new Map<string, { d: string }>(),
  );

  useLayoutEffect(() => {
    cancelAnimationFrame(criticalAnimFrameRef.current);

    const svg = svgRef.current;
    const prev = prevCriticalPathDataRef.current;
    const currentKeys = new Set(criticalPathLines.map((l) => l.key));

    // Detect exiting CP lines.
    if (prev.size > 0) {
      const exiting = new Map<string, { d: string }>();
      for (const [key, d] of prev) {
        if (!currentKeys.has(key)) {
          exiting.set(key, { d });
        }
      }
      if (exiting.size > 0) {
        setCpExitingPaths(exiting);
      } else {
        setCpExitingPaths((prev) => (prev.size > 0 ? new Map() : prev));
      }
    }

    if (svg) {
      const toMove: { el: SVGPathElement; from: string; to: string }[] = [];
      const toEnter: { el: SVGPathElement; sx: number; sy: number; target: string }[] = [];

      for (const line of criticalPathLines) {
        const oldD = prev.get(line.key);
        const el = svg.querySelector<SVGPathElement>(`.cp-line[data-key="${line.key}"]`);
        if (!el) continue;

        if (oldD && oldD !== line.d) {
          toMove.push({ el, from: oldD, to: line.d });
          el.setAttribute("d", oldD);
        } else if (!oldD) {
          const m = line.d.match(/^M\s+([\d.-]+)\s+([\d.-]+)/);
          if (m) {
            el.setAttribute("d", collapsedPath(m[1], m[2]));
            toEnter.push({ el, sx: +m[1], sy: +m[2], target: line.d });
          }
        }
      }

      if (toMove.length > 0 || toEnter.length > 0) {
        const duration = 250;
        const start = performance.now();

        const animate = (now: number) => {
          const t = Math.min((now - start) / duration, 1);
          const eased = easeInOutQuad(t);
          for (const { el, from, to } of toMove) {
            el.setAttribute("d", interpolatePath(from, to, eased));
          }
          for (const { el, sx, sy, target } of toEnter) {
            el.setAttribute("d", traceGrowPath(sx, sy, target, eased));
          }
          if (t < 1) {
            criticalAnimFrameRef.current = requestAnimationFrame(animate);
          }
        };

        criticalAnimFrameRef.current = requestAnimationFrame(animate);
      }
    }

    prevCriticalPathDataRef.current = new Map(
      criticalPathLines.map((l) => [l.key, l.d]),
    );

    return () => cancelAnimationFrame(criticalAnimFrameRef.current);
  }, [criticalPathLines]);

  // CP exit animation: snake collapse.
  useLayoutEffect(() => {
    cancelAnimationFrame(cpExitAnimFrameRef.current);
    if (cpExitingPaths.size === 0) return;

    const svg = svgRef.current;
    if (!svg) return;

    const toExit: { el: SVGPathElement; sx: number; sy: number; original: string }[] = [];
    for (const [key, data] of cpExitingPaths) {
      const el = svg.querySelector<SVGPathElement>(`.cp-line-exit[data-key="exit-${key}"]`);
      if (!el) continue;
      const m = data.d.match(/^M\s+([\d.-]+)\s+([\d.-]+)/);
      if (m) {
        el.setAttribute("d", data.d);
        toExit.push({ el, sx: +m[1], sy: +m[2], original: data.d });
      }
    }

    if (toExit.length === 0) return;

    const duration = 250;
    const start = performance.now();

    const animate = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = easeInOutQuad(t);
      for (const { el, sx, sy, original } of toExit) {
        el.setAttribute("d", traceGrowPath(sx, sy, original, 1 - eased));
      }
      if (t < 1) {
        cpExitAnimFrameRef.current = requestAnimationFrame(animate);
      } else {
        setCpExitingPaths(new Map());
      }
    };

    cpExitAnimFrameRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(cpExitAnimFrameRef.current);
  }, [cpExitingPaths]);

  // Set of related crate IDs (target + its deps + its dependents).
  const relatedIds = useMemo(() => {
    if (!lineTargetId) return null;
    const set = new Set<string>();
    set.add(lineTargetId);
    const d = deps.get(lineTargetId);
    if (d) for (const id of d) set.add(id);
    const dn = dependents.get(lineTargetId);
    if (dn) for (const id of dn) set.add(id);
    return set;
  }, [lineTargetId, deps, dependents]);

  const handleClick = useCallback(
    (node: CrateNode) => {
      setSelectedId((prev) => (prev === node.id ? null : node.id));
      onNodeSelect(node);
    },
    [onNodeSelect],
  );

  const handleBgClick = useCallback(
    () => {
      onNodeSelect(null);
      setSelectedId(null);
    },
    [onNodeSelect],
  );


  // Generate time grid lines.
  const gridLines = useMemo(() => {
    if (totalMs === 0) return [];
    const rawStep = totalMs / 10;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const candidates = [1, 2, 5, 10].map((m) => m * magnitude);
    const step =
      candidates.find((c) => totalMs / c <= 12) ??
      candidates[candidates.length - 1];
    const lines: { ms: number; label: string }[] = [];
    for (let ms = 0; ms <= totalMs; ms += step) {
      lines.push({ ms, label: formatMs(ms) });
    }
    return lines;
  }, [totalMs]);

  const totalHeight = HEADER_HEIGHT + entries.length * (ROW_HEIGHT + ROW_GAP);

  return (
    <div
      ref={containerRef}
      className="timeline"
      onClick={handleBgClick}
      onMouseLeave={() => setHoveredId(null)}
      style={{ height: "100%", overflow: "auto" }}
    >
      <div
        ref={chartRef}
        style={{ minHeight: totalHeight, position: "relative" }}
      >
        {/* Time axis header */}
        <div
          className="timeline-header"
          style={{
            position: "sticky",
            top: 0,
            zIndex: 10,
            height: HEADER_HEIGHT,
          }}
        >
          <div style={{ position: "relative", height: "100%", marginLeft: PADDING_LEFT, marginRight: PADDING_RIGHT }}>
            {gridLines.map((line) => (
              <span
                key={line.ms}
                className="timeline-tick"
                data-ms={line.ms}
                style={{ left: `${(line.ms / totalMs) * 100}%` }}
              >
                {line.label}
              </span>
            ))}
          </div>
        </div>

        {/* Grid line overlay (single set instead of per-row) */}
        <div
          style={{
            position: "absolute",
            top: HEADER_HEIGHT,
            left: PADDING_LEFT,
            right: PADDING_RIGHT,
            height: totalHeight - HEADER_HEIGHT,
            pointerEvents: "none",
          }}
        >
          {gridLines.map((line) => (
            <div
              key={line.ms}
              className="timeline-gridline"
              data-grid-ms={line.ms}
              style={{ left: `${(line.ms / totalMs) * 100}%` }}
            />
          ))}
        </div>

        {/* SVG overlay for dependency curves */}
        {(depPathMap.size > 0 || exitingPaths.size > 0 || criticalPathLines.length > 0 || cpExitingPaths.size > 0) && (
          <div
            style={{
              position: "absolute",
              top: 0,
              left: PADDING_LEFT,
              right: PADDING_RIGHT,
              height: totalHeight,
              pointerEvents: "none",
              zIndex: 4,
            }}
          >
            <svg
              ref={svgRef}
              width="100%"
              height="100%"
              viewBox={`0 0 100 ${totalHeight}`}
              preserveAspectRatio="none"
            >
              {criticalPathLines.map((line) => (
                <path
                  key={line.key}
                  className="cp-line"
                  data-key={line.key}
                  d={line.d}
                  stroke={COLOR_CRITICAL}
                  strokeWidth={1}
                  strokeOpacity={0.25}
                  strokeDasharray="4 3"
                  fill="none"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {[...depPathMap.entries()].map(([key, path]) => (
                <path
                  key={key}
                  className="dep-line"
                  data-key={key}
                  d={path.d}
                  stroke={path.color}
                  strokeWidth={1.5}
                  strokeOpacity={0.7}
                  fill="none"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {[...exitingPaths.entries()].map(([key, path]) => (
                <path
                  key={`exit-${key}`}
                  className="dep-line dep-line-exit"
                  d={path.d}
                  stroke={path.color}
                  strokeWidth={1.5}
                  fill="none"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {[...cpExitingPaths.entries()].map(([key, data]) => (
                <path
                  key={`exit-${key}`}
                  className="cp-line-exit"
                  data-key={`exit-${key}`}
                  d={data.d}
                  stroke={COLOR_CRITICAL}
                  strokeWidth={1}
                  strokeOpacity={0.25}
                  strokeDasharray="4 3"
                  fill="none"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </svg>
          </div>
        )}

        {/* Rows */}
        {entries.map((entry, i) => {
          const top = HEADER_HEIGHT + i * (ROW_HEIGHT + ROW_GAP);
          const leftPct = totalMs > 0 ? (entry.startMs / totalMs) * 100 : 0;
          const widthPct =
            totalMs > 0
              ? Math.max((entry.durationMs / totalMs) * 100, 0.3)
              : 0;
          const isDimmed =
            relatedIds !== null && !relatedIds.has(entry.node.id);
          const isSelected = selectedId === entry.node.id;
          const isDepOfSelected =
            selectedDeps !== null && selectedDeps.has(entry.node.id);
          const showRemoveBtn = isDepOfSelected && hoveredId === entry.node.id;

          return (
            <div
              key={entry.node.id}
              className="timeline-row"
              style={{ top, height: ROW_HEIGHT, opacity: isDimmed ? 0.25 : 1 }}
            >
              {/* Chart area */}
              <div
                className="timeline-chart"
                style={{
                  left: PADDING_LEFT,
                  right: PADDING_RIGHT,
                }}
              >
                {/* Bar */}
                <div
                  className={[
                    "timeline-bar",
                    entry.isCritical ? "critical" : "",
                    isSelected ? "selected" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  data-id={entry.node.id}
                  style={{
                    left: `${leftPct}%`,
                    width: `${widthPct}%`,
                    backgroundColor: COLOR_ACCENT,
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleClick(entry.node);
                  }}
                  onMouseEnter={() => setHoveredId(entry.node.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  title={`${entry.node.name}: ${formatMs(entry.durationMs)}`}
                >
                  <span className="timeline-bar-label">
                    {entry.node.name}
                  </span>
                  {showRemoveBtn && (
                    <button
                      className="remove-dep-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemoveEdge(selectedId!, entry.node.id);
                      }}
                      title="Remove this dependency (what-if analysis)"
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
