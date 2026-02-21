use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub use crate::model::crate_id::CrateId;
pub use crate::model::milliseconds::Milliseconds;
mod crate_id {
    use serde::{Deserialize, Serialize};
    #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
    pub struct CrateId(String);
    use cargo_metadata::Package;
    impl From<&Package> for CrateId {
        fn from(pkg: &Package) -> Self {
            CrateId(format!("{}@{}", pkg.name, pkg.version))
        }
    }
    impl From<&cargo_metadata::PackageId> for CrateId {
        fn from(pkg_id: &cargo_metadata::PackageId) -> Self {
            CrateId(pkg_id.repr.clone())
        }
    }

    #[cfg(test)]
    mod tests {

        use super::*;
        use cargo_metadata::{PackageBuilder, PackageId, camino::Utf8PathBuf, semver::Version};

        #[test]
        fn from_package() {
            let pkg = PackageBuilder::new(
                "test_crate",
                Version::new(1, 0, 5),
                PackageId {
                    repr: "this is ignored".to_string(),
                },
                Utf8PathBuf::new(),
            )
            .build()
            .unwrap();
            let id = CrateId::from(&pkg);
            assert_eq!("test_crate@1.0.5", id.0);
        }

        #[test]
        fn from_package_id() {
            let pkg_id = PackageId {
                repr: "crate@1.2.3".to_string(),
            };
            let id = CrateId::from(&pkg_id);
            assert_eq!("crate@1.2.3", id.0);
        }
    }
}

mod milliseconds {
    use std::ops::Add;

    use serde::{Deserialize, Serialize};

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

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn milliseconds_add() {
            let a = Milliseconds(10.0);
            let b = Milliseconds(15.0);
            let sum = a + b;
            assert_eq!(25.0, sum.0);
        }

        #[test]
        fn milliseconds_zero() {
            let zero = Milliseconds::zero();
            assert_eq!(0.0, zero.0);
        }
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
