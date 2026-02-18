use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=frontend/src");
    println!("cargo:rerun-if-changed=frontend/dist");
    println!("cargo:rerun-if-changed=frontend/package.json");
    println!("cargo:rerun-if-changed=frontend/index.html");
    println!("cargo:rerun-if-changed=frontend/bun.lock");

    let frontend_dir = "frontend";

    // Try to run bun. If unavailable (or SKIP_BUN=1), fall back to prebuilt assets.
    let skip_bun = std::env::var("SKIP_BUN").is_ok_and(|v| v == "1");
    let bun_available = !skip_bun && Command::new("bun")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success());

    if !bun_available {
        let has_assets = std::fs::read_dir("frontend/dist/assets")
            .map(|entries| {
                entries
                    .flatten()
                    .any(|e| e.path().extension().is_some_and(|ext| ext == "js"))
            })
            .unwrap_or(false);

        assert!(
            has_assets,
            "bun is not installed and no prebuilt frontend assets found in frontend/dist/assets. \
             Install bun (https://bun.sh) or use a release that includes prebuilt assets."
        );
        return;
    }

    let status = Command::new("bun")
        .args(["install", "--frozen-lockfile"])
        .current_dir(frontend_dir)
        .status()
        .expect("failed to run bun install");
    assert!(status.success(), "bun install failed");

    let status = Command::new("bun")
        .args(["run", "build"])
        .current_dir(frontend_dir)
        .status()
        .expect("failed to run bun run build");
    assert!(status.success(), "bun run build failed");
}
