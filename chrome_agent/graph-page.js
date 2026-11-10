import { renderGraph } from "./graph-view.js";
import { openGraphNode } from "./graph-actions.js";
import { moveConversation, renameProject } from "./graph-state.js";
import { searchTitles } from "./grouping.js";

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
      renderGraph(graph, [], detail, setStatus, () => {}, () => {});
      counts.textContent = "No data";
      setStatus("Import a CSV or extract conversations from the side panel to build a graph.");
      return;
    }

    renderGraph(
      graph,
      saved.projects,
      detail,
      setStatus,
      (node) => openGraphNode(node, saved.projects, setStatus),
      (change) => editSavedGraph(saved, change),
      { search: (query) => searchTitles(query) },
    );
    counts.textContent = `${saved.projects.length} project(s) · ${saved.conversations.length} conversation(s)`;
    setStatus(saved.source ? `Source: ${saved.source}` : "Saved graph");
  } catch (error) {
    setStatus(`Could not load the saved graph: ${error.message}`);
  }
}

async function editSavedGraph(saved, change) {
  try {
    let updatedProjects;
    if (change.type === "rename") {
      updatedProjects = renameProject(saved.projects, change.projectId, change.name);
    } else if (change.type === "move") {
      updatedProjects = moveConversation(saved.projects, change.projectId, change.targetProjectId, change.url);
    } else {
      throw new Error("Unknown graph edit.");
    }
    await chrome.storage.local.set({
      [STORAGE_KEY]: { ...saved, projects: updatedProjects, savedAt: new Date().toISOString() },
    });
    setStatus(change.type === "rename"
      ? "Project renamed."
      : "Conversation moved to the selected project.");
  } catch (error) {
    setStatus(`Could not update project graph: ${error.message}`);
  }
}

function setStatus(message) {
  status.textContent = message;
}
