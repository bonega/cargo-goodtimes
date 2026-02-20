use std::path::Path;

use rust_embed::Embed;

use crate::model::BuildGraph;

#[derive(Embed)]
#[folder = "frontend/dist/assets"]
struct FrontendAsset;

pub fn write_and_open(graph: &BuildGraph, target_dir: &Path, open: bool) -> anyhow::Result<()> {
    let html = generate_html(graph)?;
    let out_dir = target_dir.join("cargo-goodtimes");
    std::fs::create_dir_all(&out_dir)?;
    let out_path = out_dir.join("index.html");
    std::fs::write(&out_path, &html)?;
    tracing::info!("wrote {}", out_path.display());

    if open {
        let url = format!("file://{}", out_path.canonicalize()?.display());
        webbrowser::open(&url)?;
    }

    Ok(())
}

fn generate_html(graph: &BuildGraph) -> anyhow::Result<String> {
    // Find the JS and CSS assets (Vite adds content hashes to filenames).
    let mut js_source = None;
    let mut css_source = None;

    for filename in FrontendAsset::iter() {
        if filename.ends_with(".js") {
            let file = FrontendAsset::get(&filename)
                .ok_or_else(|| anyhow::anyhow!("missing embedded file: {filename}"))?;
            js_source = Some(String::from_utf8(file.data.to_vec())?);
        } else if filename.ends_with(".css") {
            let file = FrontendAsset::get(&filename)
                .ok_or_else(|| anyhow::anyhow!("missing embedded file: {filename}"))?;
            css_source = Some(String::from_utf8(file.data.to_vec())?);
        }
    }

    let js =
        js_source.ok_or_else(|| anyhow::anyhow!("no .js asset found in frontend/dist/assets"))?;
    let css =
        css_source.ok_or_else(|| anyhow::anyhow!("no .css asset found in frontend/dist/assets"))?;

    // Serialize graph JSON, escaping </script to prevent premature tag closing.
    let graph_json = serde_json::to_string(graph)?;
    let graph_json = graph_json.replace("</script", "<\\/script");

    Ok(format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>cargo goodtimes</title>
<style>{css}</style>
</head>
<body>
<div id="root"></div>
<script>window.__GRAPH_DATA__ = {graph_json};</script>
<script type="module">{js}</script>
</body>
</html>"#
    ))
}
