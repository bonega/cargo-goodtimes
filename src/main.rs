use std::path::Path;

use clap::Parser;

mod cargo_ops;
mod cli;
mod model;
mod output;

fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let cli::Cargo::Goodtimes(args) = cli::Cargo::parse();

    let manifest_path = resolve_manifest(&args.manifest_path)?;
    tracing::info!("using manifest: {manifest_path}");

    let mut graph =
        cargo_ops::metadata::load_dependency_graph(&manifest_path, args.include_deps)?;
    tracing::info!("loaded {} crates", graph.nodes.len());

    if args.include_deps {
        // Full clean so third-party deps are also recompiled and timed.
        tracing::info!("cleaning all crates…");
        let status = std::process::Command::new("cargo")
            .args(["clean", "--manifest-path", &manifest_path])
            .status()?;
        anyhow::ensure!(status.success(), "cargo clean failed");
    } else {
        // Ensure third-party deps are compiled before we clean workspace crates.
        tracing::info!("Pre-building dependencies...");
        cargo_ops::build::prebuild_deps(
            &manifest_path,
            &args.profile,
            &args.features,
            args.all_features,
        )?;

        // Clean only workspace crates so external deps stay cached.
        let ws_packages = cargo_ops::metadata::workspace_package_names(&manifest_path)?;
        tracing::info!("cleaning {} workspace crate(s)…", ws_packages.len());
        let mut clean_cmd = std::process::Command::new("cargo");
        clean_cmd.args(["clean", "--manifest-path", &manifest_path]);
        for pkg in &ws_packages {
            clean_cmd.args(["-p", pkg]);
        }
        let status = clean_cmd.status()?;
        anyhow::ensure!(status.success(), "cargo clean failed");
    }

    // Run an initial build to collect timing data.
    tracing::info!("running initial build…");
    cargo_ops::build::run_build(
        &manifest_path,
        &args.profile,
        &args.features,
        args.all_features,
    )?;
    cargo_ops::build::apply_timings(&mut graph, &manifest_path)?;
    tracing::info!("initial build complete");

    let target_dir = cargo_ops::build::find_target_dir(&manifest_path)?;
    output::write_and_open(&graph, &target_dir, !args.no_open)
}

fn resolve_manifest(path: &str) -> anyhow::Result<String> {
    let p = Path::new(path);
    if p.is_file() {
        Ok(p.canonicalize()?.to_string_lossy().into_owned())
    } else if p.is_dir() {
        let manifest = p.join("Cargo.toml");
        anyhow::ensure!(manifest.exists(), "no Cargo.toml found in {path}");
        Ok(manifest.canonicalize()?.to_string_lossy().into_owned())
    } else {
        anyhow::bail!("path does not exist: {path}");
    }
}
