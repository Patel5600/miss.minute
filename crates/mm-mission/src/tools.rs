//! Tool manifests, server-derived side-effect classification, and untrusted MCP importer.

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ToolError {
    #[error("invalid tool manifest: {0}")]
    InvalidManifest(&'static str),
    #[error(
        "explicit owner confirmation is required to reclassify or execute external MCP tool `{0}`"
    )]
    ConfirmationRequired(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SideEffect {
    ReadOnly = 0,
    LocalWrite = 1,
    External = 2,
    Destructive = 3,
    Financial = 4,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolBehaviorFlags {
    pub mutates_local_state: bool,
    pub contacts_external_origin: bool,
    pub irreversible_or_deletes: bool,
    pub transfers_money_or_purchase: bool,
}

/// Derives authoritative side-effect class purely from server/declared behavior flags & tags,
/// ignoring any optimistic `claimed_side_effect` supplied by an untrusted plugin/MCP server.
pub fn derive_side_effect(flags: &ToolBehaviorFlags, raw_description: &str) -> SideEffect {
    let lower = raw_description.to_ascii_lowercase();
    if flags.transfers_money_or_purchase
        || lower.contains("payment")
        || lower.contains("purchase")
        || lower.contains("wire ")
        || lower.contains("checkout")
    {
        return SideEffect::Financial;
    }
    if flags.irreversible_or_deletes
        || lower.contains("delete")
        || lower.contains("rm ")
        || lower.contains("prune")
        || lower.contains("drop table")
    {
        return SideEffect::Destructive;
    }
    if flags.contacts_external_origin
        || lower.contains("webhook")
        || lower.contains("http")
        || lower.contains("email")
        || lower.contains("call ")
        || lower.contains("upload")
    {
        return SideEffect::External;
    }
    if flags.mutates_local_state {
        return SideEffect::LocalWrite;
    }
    SideEffect::ReadOnly
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolManifest {
    pub id: String,
    pub name: String,
    pub description: String,
    pub trusted_builtin: bool,
    pub derived_side_effect: SideEffect,
    pub owner_approved_reclassification: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub read_only_hint: bool,
    #[serde(default)]
    pub destructive_hint: bool,
    #[serde(default)]
    pub open_world_hint: bool,
}

/// Imports an untrusted MCP JSON tool descriptor.
/// Security rule: Untrusted MCP tools ALWAYS default to AT LEAST `SideEffect::External`
/// regardless of `readOnlyHint: true`, requiring explicit owner approval before lower classification.
pub fn import_mcp_tool(server_name: &str, json_str: &str) -> Result<ToolManifest, ToolError> {
    let input: McpToolInput =
        serde_json::from_str(json_str).map_err(|_| ToolError::InvalidManifest("malformed_json"))?;
    let name = input.name.trim();
    if name.is_empty() || server_name.trim().is_empty() {
        return Err(ToolError::InvalidManifest("empty_server_or_tool_name"));
    }
    let flags = ToolBehaviorFlags {
        mutates_local_state: !input.read_only_hint,
        contacts_external_origin: true, // MCP servers cross process/network trust boundary
        irreversible_or_deletes: input.destructive_hint,
        transfers_money_or_purchase: false,
    };
    let derived = derive_side_effect(&flags, &input.description).max(SideEffect::External);
    Ok(ToolManifest {
        id: format!("mcp:{}:{}", server_name.trim(), name),
        name: name.to_owned(),
        description: input.description,
        trusted_builtin: false,
        derived_side_effect: derived,
        owner_approved_reclassification: false,
    })
}

pub fn reclassify_mcp_tool(
    manifest: &mut ToolManifest,
    requested: SideEffect,
    owner_confirmed: bool,
) -> Result<(), ToolError> {
    if !owner_confirmed {
        return Err(ToolError::ConfirmationRequired(manifest.id.clone()));
    }
    if matches!(manifest.derived_side_effect, SideEffect::Financial)
        && requested < SideEffect::Financial
    {
        return Err(ToolError::InvalidManifest(
            "cannot_downgrade_financial_tool",
        ));
    }
    manifest.derived_side_effect = requested;
    manifest.owner_approved_reclassification = true;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn untrusted_mcp_read_only_hint_still_defaults_to_external() {
        let json = r#"{"name":"fetch_docs","description":"Read documentation","readOnlyHint":true,"destructiveHint":false}"#;
        let mut tool = import_mcp_tool("untrusted-docs", json).unwrap();
        assert_eq!(tool.derived_side_effect, SideEffect::External);
        assert!(!tool.owner_approved_reclassification);

        assert!(reclassify_mcp_tool(&mut tool, SideEffect::ReadOnly, false).is_err());
        reclassify_mcp_tool(&mut tool, SideEffect::ReadOnly, true).unwrap();
        assert_eq!(tool.derived_side_effect, SideEffect::ReadOnly);
        assert!(tool.owner_approved_reclassification);
    }

    #[test]
    fn financial_and_destructive_keywords_escalate_derived_classification() {
        let pay = r#"{"name":"run_step","description":"Submit payment webhook to vendor","readOnlyHint":true}"#;
        let tool = import_mcp_tool("vendor", pay).unwrap();
        assert_eq!(tool.derived_side_effect, SideEffect::Financial);
    }
}
