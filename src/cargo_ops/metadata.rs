use cargo_metadata::{MetadataCommand, PackageId};
use std::collections::{HashMap, HashSet};

use crate::model::{BuildGraph, CrateNode, DepEdge};

pub fn load_dependency_graph(
    manifest_path: &str,
    include_deps: bool,
) -> anyhow::Result<BuildGraph> {
    let metadata = MetadataCommand::new()
        .manifest_path(manifest_path)
        .exec()?;

    let resolve = metadata
        .resolve
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("no dependency resolution found"))?;

    let pkg_map: HashMap<&PackageId, &cargo_metadata::Package> =
        metadata.packages.iter().map(|p| (&p.id, p)).collect();

    let ws_members: HashSet<&PackageId> = metadata.workspace_members.iter().collect();

    let mut nodes = HashMap::new();
    let mut edges = Vec::new();

    for node in &resolve.nodes {
        let is_ws = ws_members.contains(&node.id);
        if !include_deps && !is_ws {
            continue;
        }
        let Some(pkg) = pkg_map.get(&node.id) else {
            continue;
        };
        let crate_id = node.id.repr.clone();

        nodes.insert(
            crate_id.clone(),
            CrateNode {
                id: crate_id.clone(),
                name: pkg.name.clone(),
                version: pkg.version.to_string(),
                is_workspace_member: is_ws,
                duration_ms: None,
                start_ms: None,
                fresh: false,
                features: node.features.clone(),
            },
        );

        for dep in &node.deps {
            let dep_included = include_deps || ws_members.contains(&dep.pkg);
            if dep_included {
                let dep_kinds: Vec<String> = dep
                    .dep_kinds
                    .iter()
                    .map(|dk| format!("{:?}", dk.kind))
                    .collect();
                edges.push(DepEdge {
                    from: crate_id.clone(),
                    to: dep.pkg.repr.clone(),
                    dep_kinds,
                });
            }
        }
    }

    let roots = metadata
        .workspace_members
        .iter()
        .map(|id| id.repr.clone())
        .collect();

    Ok(BuildGraph {
        nodes,
        edges,
        roots,
        critical_path: Vec::new(),
    })
}

/// Return the names of all workspace member packages.
pub fn workspace_package_names(manifest_path: &str) -> anyhow::Result<Vec<String>> {
    let metadata = MetadataCommand::new()
        .manifest_path(manifest_path)
        .no_deps()
        .exec()?;

    let names = metadata
        .packages
        .iter()
        .map(|p| p.name.clone())
        .collect();

    Ok(names)
}
