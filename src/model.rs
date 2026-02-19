use serde::{Deserialize, Serialize};
use std::{collections::HashMap, ops::Add};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CrateId(String);
impl From<String> for CrateId {
    fn from(s: String) -> Self {
        CrateId(s)
    }
}
#[derive(Debug, Clone, PartialEq, PartialOrd, Copy, Serialize, Deserialize)]
pub struct Milliseconds(f64);
impl From<f64> for Milliseconds {
    fn from(value: f64) -> Self {
        Milliseconds(value)
    }
}
impl Add for Milliseconds {
    type Output = Self;

    fn add(self, other: Self) -> Self {
        Milliseconds(self.0 + other.0)
    }
}
impl Milliseconds {
    pub fn zero() -> Self {
        Milliseconds(0.0)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrateNode {
    pub id: CrateId,
    pub name: String,
    pub version: String,
    pub is_workspace_member: bool,
    /// Compilation duration (none if not yet built).
    pub duration_ms: Option<Milliseconds>,
    /// When this crate started compiling (ms from build start), None if not yet built.
    pub start_ms: Option<Milliseconds>,
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
