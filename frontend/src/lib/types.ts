export interface CrateNode {
  id: string;
  name: string;
  version: string;
  is_workspace_member: boolean;
  duration_ms: number | null;
  start_ms: number | null;
  fresh: boolean;
  features: string[];
}

export interface DepEdge {
  from: string;
  to: string;
  dep_kinds: string[];
}

export interface BuildGraph {
  nodes: Record<string, CrateNode>;
  edges: DepEdge[];
  roots: string[];
  critical_path: string[];
}
