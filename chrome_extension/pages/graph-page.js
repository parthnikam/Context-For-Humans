import { renderGraph } from "../lib/graph-view.js";
import { openGraphNode } from "../lib/graph-actions.js";
import { moveConversation } from "../lib/graph-state.js";

const STORAGE_KEY = "conversationProjectGraph";
const graph = document.querySelector("#graph");
const detail = document.querySelector("#project-detail");
const counts = document.querySelector("#counts");
const status = document.querySelector("#status");

loadGraph();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) loadGraph();
});

async function loadGraph() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const saved = stored[STORAGE_KEY];
    if (!saved || !Array.isArray(saved.projects) || !Array.isArray(saved.conversations)) {
      renderGraph(graph, [], detail, () => {}, () => {});
      counts.textContent = "No data";
      setStatus("Import a CSV or extract conversations from the side panel to build a graph.");
      return;
    }

    renderGraph(
      graph,
      saved.projects,
      detail,
      (node) => openGraphNode(node, saved.projects, setStatus),
      (change) => editSavedGraph(saved, change),
      { conversations: saved.conversations },
    );
    counts.textContent = `${saved.projects.length} project(s) · ${saved.conversations.length} conversation(s)`;
    setStatus(saved.source ? `Source: ${saved.source}` : "Saved graph");
  } catch (error) {
    setStatus(`Could not load the saved graph: ${error.message}`);
  }
}

async function editSavedGraph(saved, change) {
  try {
    if (change.type !== "move") {
      throw new Error("Unknown graph edit.");
    }
    const updatedProjects = moveConversation(saved.projects, change.projectId, change.targetProjectId, change.url);
    await chrome.storage.local.set({
      [STORAGE_KEY]: { ...saved, projects: updatedProjects, savedAt: new Date().toISOString() },
    });
    setStatus("Conversation moved to the selected project.");
  } catch (error) {
    setStatus(`Could not update project graph: ${error.message}`);
  }
}

function setStatus(message) {
  status.textContent = message;
}
