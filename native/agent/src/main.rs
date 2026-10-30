use std::{path::PathBuf, process::ExitCode};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use miss_minute_agent::{
    collector::{run_agent, run_one_reasoning_cycle, scan_roots},
    config::{clear_reasoner, configure_reasoner, create_config, load_config},
    store::Store,
};

#[derive(Debug, Parser)]
#[command(name = "miss-minute-agent", version, about = "Local-first background agent for Miss Minutes")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Create a config with explicit owner-authorized collection roots.
    Init {
        #[arg(long)]
        config: PathBuf,
        #[arg(long = "allow-root", required = true)]
        allow_roots: Vec<PathBuf>,
        #[arg(long)]
        confirm_owner_permission: bool,
    },
    /// Run a metadata inventory of the authorized roots.
    Scan {
        #[arg(long)]
        config: PathBuf,
    },
    /// Run independently of the browser UI. Stop with Ctrl+C or the service stop signal.
    Run {
        #[arg(long)]
        config: PathBuf,
        #[arg(long, default_value_t = 45)]
        quiet_window_seconds: u64,
        #[arg(long, default_value_t = 300)]
        rescan_seconds: u64,
    },
    /// Display the capture scope, local database counts and model configuration.
    Status {
        #[arg(long)]
        config: PathBuf,
    },
    /// Display recent locally recorded observations.
    Recent {
        #[arg(long)]
        config: PathBuf,
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
    /// Ask the configured model to evaluate unprocessed evidence once.
    Think {
        #[arg(long)]
        config: PathBuf,
    },
    /// Display locally stored model decisions.
    Decisions {
        #[arg(long)]
        config: PathBuf,
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
    /// Configure a local or explicitly approved remote OpenAI-compatible endpoint.
    ConfigureReasoner {
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        endpoint: String,
        #[arg(long)]
        model: String,
        #[arg(long)]
        api_key_env: Option<String>,
        #[arg(long)]
        confirm_remote_metadata_egress: bool,
    },
    /// Disable model reasoning without deleting collected observations.
    DisableReasoner {
        #[arg(long)]
        config: PathBuf,
    },
    /// Permanently remove the local event history, metadata index and decisions.
    ForgetHistory {
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        confirm_permanent_deletion: bool,
    },
}

fn execute(cli: Cli) -> Result<()> {
    match cli.command {
        Commands::Init { config, allow_roots, confirm_owner_permission } => {
            let created = create_config(&config, &allow_roots, confirm_owner_permission)?;
            println!("Configuration created: {}", config.display());
            println!("Local database: {}", created.database_path.display());
            println!("Owner-authorized roots:");
            for root in &created.consent.allowed_roots {
                println!("  {}", root.display());
            }
            println!("Capture scope: file metadata only. File contents are never read.");
            println!("Reasoner: disabled until explicitly configured.");
        }
        Commands::Scan { config } => {
            let config_data = load_config(&config)?;
            let mut store = Store::open(&config_data.database_path)?;
            let report = scan_roots(&config_data, &mut store)?;
            println!(
                "Files observed: {} | discovered: {} | changed: {} | inaccessible: {}",
                report.files_seen, report.resources_discovered,
                report.resources_changed, report.inaccessible_entries
            );
            if report.inaccessible_entries > 0 {
                println!("Coverage is incomplete: at least one entry could not be inspected.");
            }
        }
        Commands::Run { config, quiet_window_seconds, rescan_seconds } => {
            let config_data = load_config(&config)?;
            run_agent(&config_data, quiet_window_seconds, rescan_seconds)?;
        }
        Commands::Status { config } => {
            let config_data = load_config(&config)?;
            let store = Store::open(&config_data.database_path)?;
            let (events, resources, decisions) = store.counts()?;
            println!("Agent schema: {}", config_data.schema_version);
            println!("Owner consent recorded: {}", config_data.consent.confirmed);
            println!("Authorized roots: {}", config_data.consent.allowed_roots.len());
            for root in &config_data.consent.allowed_roots {
                println!("  {}", root.display());
            }
            println!("File contents captured: {}", config_data.capture.file_contents);
            println!("Symlink traversal: {}", config_data.capture.follow_symlinks);
            println!("Local events: {events}");
            println!("Indexed current files: {resources}");
            println!("Reasoning decisions: {decisions}");
            println!("Retention: {} days", config_data.retention_days);
            println!("Reasoner: {}", if config_data.reasoner.is_some() { "configured" } else { "disabled" });
            println!("Database: {}", config_data.database_path.display());
            println!("Completeness: not guaranteed; event delivery and OS permissions can create gaps.");
        }
        Commands::Recent { config, limit } => {
            let config_data = load_config(&config)?;
            let store = Store::open(&config_data.database_path)?;
            for event in store.recent_events(limit)? {
                println!(
                    "#{:06} {} {} source={} observed_ms={} source_ms={:?} semantics={} path={}",
                    event.seq,
                    event.id,
                    event.event_type,
                    event.source,
                    event.observed_at_unix_ms,
                    event.source_timestamp_unix_ms,
                    event.timestamp_semantics,
                    event.resource_path.as_deref().unwrap_or("-")
                );
            }
        }
        Commands::Think { config } => {
            let config_data = load_config(&config)?;
            if config_data.reasoner.is_none() {
                anyhow::bail!("No reasoner configured. Configure local Ollama or an explicitly approved HTTPS endpoint first.");
            }
            if !run_one_reasoning_cycle(&config_data)? {
                println!("No unprocessed evidence. No model request was sent.");
            }
        }
        Commands::Decisions { config, limit } => {
            let config_data = load_config(&config)?;
            let store = Store::open(&config_data.database_path)?;
            for decision in store.recent_decisions(limit)? {
                println!("{}", serde_json::to_string_pretty(&decision)?);
            }
        }
        Commands::ConfigureReasoner { config, endpoint, model, api_key_env, confirm_remote_metadata_egress } => {
            let updated = configure_reasoner(
                &config, endpoint, model, api_key_env, confirm_remote_metadata_egress,
            )?;
            println!("Reasoner configuration saved.");
            println!("Endpoint: {}", updated.reasoner.as_ref().map(|value| value.endpoint.as_str()).unwrap_or("disabled"));
            println!("Model: {}", updated.reasoner.as_ref().map(|value| value.model.as_str()).unwrap_or("disabled"));
            println!("API key value: read from the configured environment variable at runtime; never stored in config.");
            println!("Remote metadata sharing: {}", updated.reasoner.as_ref().is_some_and(|value| value.share_local_metadata_with_remote));
        }
        Commands::DisableReasoner { config } => {
            clear_reasoner(&config)?;
            println!("Reasoner disabled. Local collection remains enabled.");
        }
        Commands::ForgetHistory { config, confirm_permanent_deletion } => {
            if !confirm_permanent_deletion {
                anyhow::bail!("Pass --confirm-permanent-deletion to erase all local events, indexed metadata and decisions.");
            }
            let config_data = load_config(&config)?;
            let mut store = Store::open(&config_data.database_path)?;
            store.forget_history()?;
            println!("Local event history, current file metadata and decisions were deleted.");
            println!("Configuration and owner-authorized roots were retained.");
        }
    }
    Ok(())
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match execute(cli).with_context(|| "Miss Minutes local agent failed") {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error:#}");
            ExitCode::FAILURE
        }
    }
}
