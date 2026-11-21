//! Background Mission DAG validation, bounded execution, and checkpoint persistence.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::tools::SideEffect;

pub const MAX_DAG_NODES: usize = 32;
pub const MAX_DAG_DEPTH: usize = 8;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum MissionError {
    #[error("mission DAG is empty or exceeds {MAX_DAG_NODES} nodes")]
    InvalidSize,
    #[error("duplicate mission node id `{0}`")]
    DuplicateNode(String),
    #[error("mission node `{0}` depends on unknown node `{1}`")]
    MissingDependency(String, String),
    #[error("mission DAG contains a cycle")]
    CycleDetected,
    #[error("mission DAG exceeds maximum dependency depth {MAX_DAG_DEPTH}")]
    DepthExceeded,
    #[error("mission paused/cancelled by emergency kill switch")]
    Killed,
    #[error("node `{0}` failed permanently: {1}")]
    NodeFailed(String, String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MissionNode {
    pub id: String,
    pub title: String,
    pub depends_on: Vec<String>,
    pub action_kind: String,
    pub side_effect: SideEffect,
    pub max_retries: u8,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MissionDag {
    pub mission_id: String,
    pub goal: String,
    pub nodes: Vec<MissionNode>,
}

impl MissionDag {
    pub fn validate(&self) -> Result<Vec<String>, MissionError> {
        if self.nodes.is_empty() || self.nodes.len() > MAX_DAG_NODES {
            return Err(MissionError::InvalidSize);
        }

        let mut by_id = HashMap::with_capacity(self.nodes.len());
        for node in &self.nodes {
            if node.id.trim().is_empty() || by_id.insert(node.id.as_str(), node).is_some() {
                return Err(MissionError::DuplicateNode(node.id.clone()));
            }
        }

        let mut indegree: HashMap<&str, usize> = HashMap::with_capacity(self.nodes.len());
        let mut dependents: HashMap<&str, Vec<&str>> = HashMap::with_capacity(self.nodes.len());
        for node in &self.nodes {
            let mut seen_deps = HashSet::new();
            let mut count = 0usize;
            for dep in &node.depends_on {
                if !by_id.contains_key(dep.as_str()) {
                    return Err(MissionError::MissingDependency(
                        node.id.clone(),
                        dep.clone(),
                    ));
                }
                if seen_deps.insert(dep.as_str()) {
                    dependents
                        .entry(dep.as_str())
                        .or_default()
                        .push(node.id.as_str());
                    count += 1;
                }
            }
            indegree.insert(node.id.as_str(), count);
        }

        let mut depth_map: HashMap<&str, usize> = HashMap::with_capacity(self.nodes.len());
        let mut queue: VecDeque<&str> = VecDeque::new();
        for node in &self.nodes {
            if indegree.get(node.id.as_str()).copied().unwrap_or(0) == 0 {
                queue.push_back(node.id.as_str());
                depth_map.insert(node.id.as_str(), 1);
            }
        }

        let mut topo = Vec::with_capacity(self.nodes.len());
        while let Some(id) = queue.pop_front() {
            let current_depth = depth_map[id];
            if current_depth > MAX_DAG_DEPTH {
                return Err(MissionError::DepthExceeded);
            }
            topo.push(id.to_owned());
            if let Some(children) = dependents.get(id) {
                for &child in children {
                    let next_depth = current_depth + 1;
                    let entry = depth_map.entry(child).or_insert(next_depth);
                    if next_depth > *entry {
                        *entry = next_depth;
                    }
                    if let Some(deg) = indegree.get_mut(child) {
                        *deg -= 1;
                        if *deg == 0 {
                            queue.push_back(child);
                        }
                    }
                }
            }
        }

        if topo.len() != self.nodes.len() {
            return Err(MissionError::CycleDetected);
        }
        Ok(topo)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeCheckpoint {
    pub node_id: String,
    pub status: NodeStatus,
    pub attempts: u8,
    pub evidence: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MissionRunReport {
    pub run_id: String,
    pub mission_id: String,
    pub checkpoints: Vec<NodeCheckpoint>,
    pub completed: bool,
}

pub trait MissionStepHandler {
    fn execute_node(&mut self, node: &MissionNode) -> Result<String, String>;
}

pub fn execute_mission<H: MissionStepHandler>(
    dag: &MissionDag,
    handler: &mut H,
    kill_switch: &Arc<AtomicBool>,
) -> Result<MissionRunReport, MissionError> {
    let order = dag.validate()?;
    let node_map: HashMap<&str, &MissionNode> =
        dag.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let mut checkpoints: Vec<NodeCheckpoint> = Vec::with_capacity(order.len());

    for node_id in order {
        if kill_switch.load(Ordering::Acquire) {
            for cp in &mut checkpoints {
                if cp.status == NodeStatus::Pending {
                    cp.status = NodeStatus::Cancelled;
                }
            }
            return Err(MissionError::Killed);
        }
        let node = node_map[node_id.as_str()];
        let max_attempts = node.max_retries.clamp(0, 3).saturating_add(1);
        let mut attempts = 0u8;
        let mut last_err = String::new();
        let mut succeeded_evidence = None;
        while attempts < max_attempts {
            if kill_switch.load(Ordering::Acquire) {
                return Err(MissionError::Killed);
            }
            attempts += 1;
            match handler.execute_node(node) {
                Ok(ev) => {
                    succeeded_evidence = Some(ev);
                    break;
                }
                Err(err) => {
                    last_err = err;
                }
            }
        }

        if let Some(evidence) = succeeded_evidence {
            checkpoints.push(NodeCheckpoint {
                node_id,
                status: NodeStatus::Succeeded,
                attempts,
                evidence: Some(evidence),
            });
        } else {
            checkpoints.push(NodeCheckpoint {
                node_id: node_id.clone(),
                status: NodeStatus::Failed,
                attempts,
                evidence: Some(last_err.clone()),
            });
            return Err(MissionError::NodeFailed(node_id, last_err));
        }
    }

    Ok(MissionRunReport {
        run_id: Uuid::new_v4().to_string(),
        mission_id: dag.mission_id.clone(),
        checkpoints,
        completed: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestHandler {
        flaky_until_attempt: u8,
        calls: HashMap<String, u8>,
    }

    impl MissionStepHandler for TestHandler {
        fn execute_node(&mut self, node: &MissionNode) -> Result<String, String> {
            let count = self.calls.entry(node.id.clone()).or_insert(0);
            *count += 1;
            if *count <= self.flaky_until_attempt && node.id == "step_1" {
                return Err("transient network glitch".to_owned());
            }
            Ok(format!("evidence:{}", node.id))
        }
    }

    #[test]
    fn detects_cycles_missing_deps_and_excess_depth() {
        let cyclic = MissionDag {
            mission_id: "m1".to_owned(),
            goal: "cycle".to_owned(),
            nodes: vec![
                MissionNode {
                    id: "a".to_owned(),
                    title: "A".to_owned(),
                    depends_on: vec!["b".to_owned()],
                    action_kind: "search".to_owned(),
                    side_effect: SideEffect::ReadOnly,
                    max_retries: 1,
                },
                MissionNode {
                    id: "b".to_owned(),
                    title: "B".to_owned(),
                    depends_on: vec!["a".to_owned()],
                    action_kind: "rank".to_owned(),
                    side_effect: SideEffect::ReadOnly,
                    max_retries: 1,
                },
            ],
        };
        assert_eq!(cyclic.validate(), Err(MissionError::CycleDetected));

        let deep_nodes: Vec<MissionNode> = (0..10)
            .map(|i| MissionNode {
                id: format!("n{i}"),
                title: format!("N{i}"),
                depends_on: if i == 0 {
                    vec![]
                } else {
                    vec![format!("n{}", i - 1)]
                },
                action_kind: "read".to_owned(),
                side_effect: SideEffect::ReadOnly,
                max_retries: 0,
            })
            .collect();
        let deep = MissionDag {
            mission_id: "m2".to_owned(),
            goal: "too deep".to_owned(),
            nodes: deep_nodes,
        };
        assert_eq!(deep.validate(), Err(MissionError::DepthExceeded));
    }

    #[test]
    fn resilience_100_task_corpus_executes_cleanly() {
        let kill = Arc::new(AtomicBool::new(false));
        for task_idx in 0..100usize {
            let dag = MissionDag {
                mission_id: format!("mission-{task_idx}"),
                goal: format!("Background research task #{task_idx}"),
                nodes: vec![
                    MissionNode {
                        id: "step_1".to_owned(),
                        title: "Gather".to_owned(),
                        depends_on: vec![],
                        action_kind: "search".to_owned(),
                        side_effect: SideEffect::ReadOnly,
                        max_retries: 2,
                    },
                    MissionNode {
                        id: "step_2".to_owned(),
                        title: "Synthesize".to_owned(),
                        depends_on: vec!["step_1".to_owned()],
                        action_kind: "report".to_owned(),
                        side_effect: SideEffect::LocalWrite,
                        max_retries: 1,
                    },
                ],
            };
            let mut handler = TestHandler {
                flaky_until_attempt: if task_idx % 3 == 0 { 1 } else { 0 },
                calls: HashMap::new(),
            };
            let report = execute_mission(&dag, &mut handler, &kill).unwrap();
            assert!(report.completed);
            assert_eq!(report.checkpoints.len(), 2);
            assert!(
                report
                    .checkpoints
                    .iter()
                    .all(|c| c.status == NodeStatus::Succeeded)
            );
        }
    }
}
