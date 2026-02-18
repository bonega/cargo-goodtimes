use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub type CrateId = String;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrateNode {
    pub id: CrateId,
    pub name: String,
    pub version: String,
    pub is_workspace_member: bool,
    /// Compilation duration in milliseconds, None if not yet built.
    pub duration_ms: Option<f64>,
    /// When this crate started compiling (ms from build start), None if not yet built.
    pub start_ms: Option<f64>,
    /// Whether the artifact was fresh (cached) during the last build.
    pub fresh: bool,
    pub features: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DepEdge {
    pub from: CrateId,
    pub to: CrateId,
    pub dep_kinds: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildGraph {
    pub nodes: HashMap<CrateId, CrateNode>,
    pub edges: Vec<DepEdge>,
    pub roots: Vec<CrateId>,
    /// Node IDs on the critical path (longest accumulated compile time).
    pub critical_path: Vec<CrateId>,
}
