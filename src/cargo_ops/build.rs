use std::collections::{HashMap, HashSet};
use std::io::BufReader;
use std::path::Path;
use std::process::{Command, Stdio};

use cargo_metadata::Message;

use crate::model::{BuildGraph, CrateId};

/// Per-unit timing extracted from cargo's --timings HTML.
#[derive(Debug, Clone, serde::Deserialize)]
struct UnitTiming {
    name: String,
    version: String,
    target: String,
    start: f64,    // seconds from build start
    duration: f64, // seconds
}

/// Apply shared cargo check flags: manifest-path, profile, and features.
fn apply_common_args(cmd: &mut Command, manifest_path: &str, profile: &str, features: &[String], all_features: bool) {
    cmd.arg("check")
        .arg("--manifest-path")
        .arg(manifest_path);

    if profile == "release" {
        cmd.arg("--release");
    } else if profile != "dev" {
        cmd.arg("--profile").arg(profile);
    }

    if all_features {
        cmd.arg("--all-features");
    } else if !features.is_empty() {
        cmd.arg("--features").arg(features.join(","));
    }
}

/// Run `cargo check` without `--timings` to ensure third-party deps are compiled.
pub fn prebuild_deps(
    manifest_path: &str,
    profile: &str,
    features: &[String],
    all_features: bool,
) -> anyhow::Result<()> {
    let mut cmd = Command::new("cargo");
    apply_common_args(&mut cmd, manifest_path, profile, features, all_features);

    let status = cmd.status()?;
    anyhow::ensure!(status.success(), "cargo check (pre-build deps) failed");
    Ok(())
}

pub fn run_build(
    manifest_path: &str,
    profile: &str,
    features: &[String],
    all_features: bool,
) -> anyhow::Result<()> {
    let mut cmd = Command::new("cargo");
    apply_common_args(&mut cmd, manifest_path, profile, features, all_features);
    cmd.arg("--message-format=json").arg("--timings");

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("failed to capture cargo stdout"))?;
    let reader = BufReader::new(stdout);

    // Drain the message stream so cargo doesn't block on stdout.
    for message in Message::parse_stream(reader) {
        let _ = message?;
    }

    let status = child.wait()?;
    anyhow::ensure!(status.success(), "cargo check failed");
    Ok(())
}

/// Parse the cargo-timings HTML and apply real per-crate timing to the graph.
pub fn apply_timings(graph: &mut BuildGraph, manifest_path: &str) -> anyhow::Result<()> {
    let target_dir = find_target_dir(manifest_path)?;
    let timing_html = target_dir.join("cargo-timings").join("cargo-timing.html");

    if !timing_html.exists() {
        anyhow::bail!(
            "timing HTML not found at {}",
            timing_html.display()
        );
    }

    let html = std::fs::read_to_string(&timing_html)?;
    let units = parse_unit_data(&html)?;

    // Aggregate per crate (name, version) — a crate may have multiple units
    // (lib, build-script, proc-macro, bin).
    // Use only lib/check/bin targets for timeline positioning; build scripts
    // compile early and would misplace the crate in the timeline.
    let mut lib_timings: HashMap<(String, String), (f64, f64)> = HashMap::new();
    let mut all_timings: HashMap<(String, String), (f64, f64)> = HashMap::new();
    for unit in &units {
        let key = (unit.name.clone(), unit.version.clone());

        // Fallback: aggregate across all units.
        let all_entry = all_timings.entry(key.clone()).or_insert((f64::MAX, 0.0));
        all_entry.0 = all_entry.0.min(unit.start);
        all_entry.1 += unit.duration;

        // Preferred: only non-build-script units (lib, bin, proc-macro checks).
        if !unit.target.contains("build script") {
            let lib_entry = lib_timings.entry(key).or_insert((f64::MAX, 0.0));
            lib_entry.0 = lib_entry.0.min(unit.start);
            lib_entry.1 += unit.duration;
        }
    }

    // Match timings to graph nodes by name + version, preferring lib timings.
    for node in graph.nodes.values_mut() {
        let key = (node.name.clone(), node.version.clone());
        let timing = lib_timings.get(&key).or_else(|| all_timings.get(&key));
        if let Some(&(start, duration)) = timing {
            node.start_ms = Some(start * 1000.0);
            node.duration_ms = Some(duration * 1000.0);
            node.fresh = duration < 0.001; // effectively zero = cached
        }
    }

    compute_critical_path(graph);
    Ok(())
}

pub fn find_target_dir(manifest_path: &str) -> anyhow::Result<std::path::PathBuf> {
    let metadata = cargo_metadata::MetadataCommand::new()
        .manifest_path(manifest_path)
        .no_deps()
        .exec()?;
    Ok(Path::new(&metadata.target_directory).to_path_buf())
}

/// Extract UNIT_DATA JSON array from the cargo-timing HTML.
fn parse_unit_data(html: &str) -> anyhow::Result<Vec<UnitTiming>> {
    // The HTML contains: const UNIT_DATA = [{...}, ...];
    let start_marker = "const UNIT_DATA = ";
    let start_idx = html
        .find(start_marker)
        .ok_or_else(|| anyhow::anyhow!("UNIT_DATA not found in timing HTML"))?;
    let rest = &html[start_idx + start_marker.len()..];
    let end_idx = rest
        .find("];")
        .ok_or_else(|| anyhow::anyhow!("UNIT_DATA end not found"))?;
    let json_str = &rest[..=end_idx]; // include the closing ]

    let units: Vec<UnitTiming> = serde_json::from_str(json_str)?;
    Ok(units)
}

/// Compute the critical path: the longest chain by accumulated compile time.
fn compute_critical_path(graph: &mut BuildGraph) {
    // Build reverse adjacency: dependency -> vec of dependents.
    let mut dependents: HashMap<&CrateId, Vec<&CrateId>> = HashMap::new();
    for edge in &graph.edges {
        dependents.entry(&edge.to).or_default().push(&edge.from);
    }

    let mut cost: HashMap<CrateId, f64> = HashMap::new();
    let mut next_on_path: HashMap<CrateId, CrateId> = HashMap::new();

    fn longest(
        id: &CrateId,
        nodes: &HashMap<CrateId, crate::model::CrateNode>,
        dependents: &HashMap<&CrateId, Vec<&CrateId>>,
        cost: &mut HashMap<CrateId, f64>,
        next_on_path: &mut HashMap<CrateId, CrateId>,
    ) -> f64 {
        if let Some(&c) = cost.get(id) {
            return c;
        }

        let self_dur = nodes
            .get(id)
            .and_then(|n| n.duration_ms)
            .unwrap_or(0.0);

        let mut best_child_cost = 0.0_f64;
        let mut best_child: Option<&CrateId> = None;

        if let Some(deps) = dependents.get(id) {
            for dep_id in deps {
                let c = longest(dep_id, nodes, dependents, cost, next_on_path);
                if c > best_child_cost {
                    best_child_cost = c;
                    best_child = Some(dep_id);
                }
            }
        }

        let total = self_dur + best_child_cost;
        cost.insert(id.clone(), total);
        if let Some(child) = best_child {
            next_on_path.insert(id.clone(), child.clone());
        }
        total
    }

    let has_deps: HashSet<&CrateId> = graph.edges.iter().map(|e| &e.from).collect();
    let leaves: Vec<CrateId> = graph
        .nodes
        .keys()
        .filter(|id| !has_deps.contains(id))
        .cloned()
        .collect();

    let all_ids: Vec<CrateId> = graph.nodes.keys().cloned().collect();
    for id in &all_ids {
        longest(id, &graph.nodes, &dependents, &mut cost, &mut next_on_path);
    }

    let start = leaves
        .iter()
        .chain(all_ids.iter())
        .max_by(|a, b| {
            cost.get(*a)
                .unwrap_or(&0.0)
                .partial_cmp(cost.get(*b).unwrap_or(&0.0))
                .unwrap_or(std::cmp::Ordering::Equal)
        });

    let mut path = Vec::new();
    if let Some(start) = start {
        let mut cur = start.clone();
        loop {
            path.push(cur.clone());
            match next_on_path.get(&cur) {
                Some(next) => cur = next.clone(),
                None => break,
            }
        }
    }

    graph.critical_path = path;
}
