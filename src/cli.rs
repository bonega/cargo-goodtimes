use clap::Parser;

#[derive(Parser)]
#[command(name = "cargo", bin_name = "cargo")]
pub enum Cargo {
    Goodtimes(Args),
}

#[derive(clap::Args, Debug)]
#[command(version, about = "Interactive compilation timing analyzer")]
pub struct Args {
    /// Path to Cargo.toml or directory containing it.
    #[arg(long, default_value = ".")]
    pub manifest_path: String,

    /// Build profile.
    #[arg(long, default_value = "dev")]
    pub profile: String,

    /// Features to enable (comma-separated).
    #[arg(long, value_delimiter = ',')]
    pub features: Vec<String>,

    /// Enable all features.
    #[arg(long)]
    pub all_features: bool,

    /// Don't open browser automatically.
    #[arg(long)]
    pub no_open: bool,
}
