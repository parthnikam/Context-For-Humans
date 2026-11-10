import { parseConversationCsv } from "./csv.js";
import { extractConversations } from "./extraction.js";
import {
  clearChromaIndex,
  DEFAULT_SIMILARITY_THRESHOLD,
  groupConversations,
  syncProjectAssignments,
  testGeminiKey,
  testChromaService,
} from "./grouping.js";
import { openGraphNode } from "./graph-actions.js";
import { renderGraph } from "./graph-view.js";
import { appendGraphData, moveConversation, renameProject } from "./graph-state.js";
import { runPageAction } from "./page-actions.js";
import { createCsvDownload } from "./csv-download.js";

const STORAGE_KEY = "conversationProjectGraph";
const GEMINI_KEY = "conversationGeminiApiKey";
const LEGACY_MEM0_KEY = "conversationMem0ApiKey";
const SIMILARITY_THRESHOLD_KEY = "chromaSimilarityThreshold";

const scanButton = document.querySelector("#detect-areas");
const areaSelect = document.querySelector("#area-select");
const extractButton = document.querySelector("#extract");
const cancelButton = document.querySelector("#cancel");
const csvInput = document.querySelector("#csv-file");
const fileName = document.querySelector("#file-name");
const status = document.querySelector("#status");
const counts = document.querySelector("#counts");
const graph = document.querySelector("#graph");
const detail = document.querySelector("#project-detail");
const settings = document.querySelector("#settings");
const apiKeyInput = document.querySelector("#api-key");
const similarityThresholdInput = document.querySelector("#similarity-threshold");
const downloadButton = document.querySelector("#download");
const viewLargerLink = document.querySelector("#view-larger");
const debugOutput = document.querySelector("#debug-output");
const debugCount = document.querySelector("#debug-count");

let areas = [];
let projects = [];
let conversations = [];
let graphSource = "";
let debugEntries = [];
let cancelled = false;
let busy = false;

scanButton.addEventListener("click", detectAreas);
areaSelect.addEventListener("change", selectArea);
extractButton.addEventListener("click", extractAndGroup);
cancelButton.addEventListener("click", () => {
  cancelled = true;
  setStatus("Stopping after the current scroll step...");
});
csvInput.addEventListener("change", importCsv);
downloadButton.addEventListener("click", () => createCsvDownload(conversations));
document.querySelector("#key-form").addEventListener("submit", saveApiKey);
document.querySelector("#test-gemini-key").addEventListener("click", testGeminiApiKey);
document.querySelector("#test-chroma").addEventListener("click", testChromaServiceConnection);
document.querySelector("#clear-graphs").addEventListener("click", clearGraphs);
document.querySelector("#clear-debug").addEventListener("click", clearDebug);
similarityThresholdInput.addEventListener("change", saveSimilarityThreshold);
document.querySelector("#settings-toggle").addEventListener("click", () => {
  settings.open = !settings.open;
  document.querySelector("#settings-toggle").setAttribute("aria-expanded", String(settings.open));
});

initialize();

async function initialize() {
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEY, GEMINI_KEY, SIMILARITY_THRESHOLD_KEY]);
    await chrome.storage.local.remove(LEGACY_MEM0_KEY);
    apiKeyInput.value = String(stored[GEMINI_KEY] || "");
    similarityThresholdInput.value = String(readSimilarityThreshold(stored[SIMILARITY_THRESHOLD_KEY]));
    const saved = stored[STORAGE_KEY];
    if (saved && Array.isArray(saved.projects) && Array.isArray(saved.conversations)) {
      projects = saved.projects;
      conversations = saved.conversations;
      graphSource = String(saved.source || "");
      render();
      if (conversations.length) setStatus(`Loaded ${conversations.length} saved conversation(s).`);
    }
  } catch (error) {
    setStatus(`Could not load saved data: ${error.message}`);
  }
}

async function saveApiKey(event) {
  event.preventDefault();
  const key = apiKeyInput.value.trim();
  if (!key) {
    setStatus("Enter a Gemini API key to save.");
    return;
  }
  try {
    await chrome.storage.local.set({ [GEMINI_KEY]: key });
    setStatus("Gemini API key saved locally.");
  } catch (error) {
    setStatus(`Could not save API key: ${error.message}`);
  }
}

async function testGeminiApiKey() {
  const key = apiKeyInput.value.trim();
  if (!key) {
    setStatus("Enter a Gemini API key to test.");
    apiKeyInput.focus();
    return;
  }
  const testButton = document.querySelector("#test-gemini-key");
  testButton.disabled = true;
  setStatus("Testing Gemini API key...");
  try {
    await testGeminiKey(key);
    setStatus("Gemini API key works.");
  } catch (error) {
    setStatus(error.message);
  } finally {
    testButton.disabled = false;
  }
}

async function testChromaServiceConnection() {
  const button = document.querySelector("#test-chroma");
  button.disabled = true;
  setStatus("Checking local ChromaDB service...");
  try {
    const health = await testChromaService({ onDebug: appendDebug });
    setStatus(`ChromaDB is ready (${health.stored_titles} title(s) indexed).`);
  } catch (error) {
    setStatus(error.message);
  } finally {
    button.disabled = false;
  }
}

async function saveSimilarityThreshold() {
  const rawThreshold = similarityThresholdInput.value.trim();
  const threshold = rawThreshold ? Number(rawThreshold) : Number.NaN;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    setStatus("Similarity threshold must be between 0 and 1.");
    similarityThresholdInput.value = String(DEFAULT_SIMILARITY_THRESHOLD);
    return;
  }
  try {
    await chrome.storage.local.set({ [SIMILARITY_THRESHOLD_KEY]: threshold });
    setStatus(`Chroma cosine similarity threshold saved: ${threshold.toFixed(2)}.`);
  } catch (error) {
    setStatus(`Could not save similarity threshold: ${error.message}`);
  }
}

async function detectAreas() {
  setBusy(true);
  areas = [];
  areaSelect.disabled = true;
  areaSelect.replaceChildren(new Option("Scanning active page...", ""));
  setStatus("Detecting scrollable areas on the active tab...");
  try {
    await runOnActiveTab({ type: "clear-highlight" });
    const result = await runOnActiveTab({ type: "detect" });
    if (!result?.ok) throw new Error(result?.error || "Could not detect scrollable areas.");
    areas = result.areas;
    areaSelect.replaceChildren();
    if (!areas.length) {
      areaSelect.append(new Option("No scrollable areas found", ""));
      setStatus("No scrollable areas found. Open the chat sidebar and scan again.");
      return;
    }
    areaSelect.append(new Option("Choose a chat list...", ""));
    areas.forEach((area, index) => {
      const sample = area.samples.length ? ` — ${area.samples.slice(0, 2).join(", ")}` : "";
      areaSelect.append(new Option(`${area.label} (${area.size}, ${area.visibleLinks} link(s))${sample}`, String(index)));
    });
    areaSelect.disabled = false;
    setStatus(`Found ${areas.length} scrollable area(s). Select the conversation list.`);
  } catch (error) {
    areas = [];
    areaSelect.replaceChildren(new Option("Detection failed", ""));
    setStatus(error.message);
  } finally {
    setBusy(false);
  }
}

async function selectArea() {
  const area = getSelectedArea();
  extractButton.disabled = busy || !area;
  if (!area) return;
  setStatus(`Highlighting ${area.label}...`);
  try {
    const result = await runOnActiveTab({ type: "highlight", selector: area.selector, label: area.label });
    if (!result?.ok) throw new Error(result?.error || "Could not highlight that area.");
    setStatus("The selected area is highlighted on the page.");
  } catch (error) {
    setStatus(error.message);
  }
}

async function extractAndGroup() {
  const area = getSelectedArea();
  if (!area || busy) return;
  setBusy(true);
  cancelled = false;
  cancelButton.hidden = false;
  try {
    const result = await extractConversations({
      area,
      runOnActiveTab,
      isCancelled: () => cancelled,
      onStatus: setStatus,
    });
    if (result.error) throw new Error(result.error);
    if (!result.conversations.length) {
      setStatus(result.message || "No conversations were found.");
      return;
    }
    await groupAndShow(result.conversations, "Extracted from page");
    if (result.restoreError) setStatus(`Added conversations. Could not restore scroll position: ${result.restoreError}`);
  } catch (error) {
    setStatus(error.message);
  } finally {
    cancelButton.hidden = true;
    setBusy(false);
  }
}

async function importCsv() {
  const file = csvInput.files?.[0];
  if (!file) return;
  fileName.textContent = file.name;
  if (file.size > 5 * 1024 * 1024) {
    setStatus("CSV is larger than 5 MB.");
    csvInput.value = "";
    return;
  }
  setBusy(true);
  try {
    const entries = parseConversationCsv(await file.text());
    await groupAndShow(entries, file.name);
  } catch (error) {
    setStatus(error.message);
  } finally {
    csvInput.value = "";
    setBusy(false);
  }
}

async function groupAndShow(entries, source) {
  const knownUrls = new Set(conversations.map((conversation) => urlKey(conversation.url)));
  const newEntries = entries.filter((entry) => !knownUrls.has(urlKey(entry.url)));
  if (!newEntries.length) {
    setStatus("No new conversations to add; every URL is already in the graph.");
    return;
  }

  const stored = await chrome.storage.local.get([GEMINI_KEY, SIMILARITY_THRESHOLD_KEY]);
  const geminiApiKey = String(stored[GEMINI_KEY] || "").trim();
  if (!geminiApiKey) {
    settings.open = true;
    apiKeyInput.focus();
    throw new Error("Save a Gemini API key in AI grouping settings to create project groups.");
  }

  const grouped = await groupConversations({
    geminiApiKey,
    conversations: newEntries,
    existingProjects: projects,
    similarityThreshold: readSimilarityThreshold(stored[SIMILARITY_THRESHOLD_KEY]),
    onStatus: setStatus,
    onDebug: appendDebug,
  });
  const appended = appendGraphData(projects, conversations, grouped, newEntries);
  const nextSource = graphSource
    ? [...new Set([...graphSource.split(", "), source])].filter(Boolean).join(", ")
    : source;
  await persistGraph(appended.projects, appended.conversations, nextSource);
  conversations = appended.conversations;
  projects = appended.projects;
  graphSource = nextSource;
  try {
    await syncProjectAssignments(assignmentsForUrls(newEntries.map((entry) => entry.url)), {
      onDebug: appendDebug,
    });
  } catch (error) {
    appendDebug({
      service: "ChromaDB",
      stage: "Save graph assignments",
      direction: "error",
      payload: { message: error.message },
    });
    render();
    setStatus(`Added conversations to the graph, but could not save their project assignments in ChromaDB: ${error.message}`);
    return;
  }
  render();
  setStatus(`Added ${newEntries.length} conversation(s); graph now has ${projects.length} project(s) and ${conversations.length} conversation(s).`);
}

async function clearGraphs() {
  if (!conversations.length && !projects.length) return;
  if (!confirm("Clear the graph and all locally indexed ChromaDB titles? This cannot be undone.")) return;
  try {
    await clearChromaIndex({ onDebug: appendDebug });
    await chrome.storage.local.remove(STORAGE_KEY);
    conversations = [];
    projects = [];
    graphSource = "";
    render();
    setStatus("Cleared the graph and local ChromaDB title index.");
  } catch (error) {
    setStatus(`Could not clear graph data: ${error.message}`);
  }
}

async function editGraph(change) {
  try {
    let updatedProjects;
    if (change.type === "rename") {
      updatedProjects = renameProject(projects, change.projectId, change.name);
    } else if (change.type === "move") {
      updatedProjects = moveConversation(projects, change.projectId, change.targetProjectId, change.url);
    } else {
      throw new Error("Unknown graph edit.");
    }
    await persistGraph(updatedProjects, conversations, graphSource);
    projects = updatedProjects;
    try {
      const affectedIds = change.type === "rename"
        ? [change.projectId]
        : [change.projectId, change.targetProjectId];
      await syncProjectAssignments(
        assignmentsForProjectIds(affectedIds),
        { onDebug: appendDebug },
      );
    } catch (error) {
      render();
      setStatus(`Graph edit saved, but ChromaDB project metadata could not be updated: ${error.message}`);
      return;
    }
    render();
    setStatus(change.type === "rename"
      ? "Project renamed."
      : "Conversation moved to the selected project.");
  } catch (error) {
    setStatus(`Could not update project graph: ${error.message}`);
  }
}

async function persistGraph(nextProjects = projects, nextConversations = conversations, source = graphSource) {
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      conversations: nextConversations,
      projects: nextProjects,
      source,
      savedAt: new Date().toISOString(),
    },
  });
}

function assignmentsForUrls(urls) {
  const selected = new Set(urls.map(urlKey));
  return projects.flatMap((project) =>
    (project.links || [])
      .filter((link) => selected.has(urlKey(link.url)))
      .map((link) => ({
        title: link.title || link.url,
        url: link.url,
        project_id: project.id,
        project_name: project.name,
      }))
  );
}

function assignmentsForProjectIds(projectIds) {
  const selected = new Set(projectIds.filter(Boolean));
  return projects
    .filter((project) => selected.has(project.id))
    .flatMap((project) => (project.links || []).map((link) => ({
      title: link.title || link.url,
      url: link.url,
      project_id: project.id,
      project_name: project.name,
    })));
}

function render() {
  renderGraph(
    graph,
    projects,
    detail,
    setStatus,
    (node) => openGraphNode(node, projects, setStatus),
    editGraph,
  );
  const projectCount = projects.length;
  counts.textContent = conversations.length
    ? `${projectCount} project(s) · ${conversations.length} conversation(s)`
    : "No data";
  downloadButton.disabled = conversations.length === 0;
  document.querySelector("#clear-graphs").disabled = conversations.length === 0 && projects.length === 0;
  const hasGraph = conversations.length > 0;
  viewLargerLink.setAttribute("aria-disabled", String(!hasGraph));
  viewLargerLink.tabIndex = hasGraph ? 0 : -1;
}

function getSelectedArea() {
  return areaSelect.value === "" ? null : areas[Number(areaSelect.value)] || null;
}

function setBusy(next) {
  busy = next;
  scanButton.disabled = next;
  csvInput.disabled = next;
  areaSelect.disabled = next || areas.length === 0;
  extractButton.disabled = next || !getSelectedArea();
  if (!next) cancelButton.hidden = true;
}

async function runOnActiveTab(action) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error("No active tab is available.");
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: runPageAction,
    args: [action],
  });
  if (!injection?.result) throw new Error("The page did not return a result.");
  return injection.result;
}

function setStatus(message) {
  status.textContent = message;
}

function appendDebug(entry) {
  const record = {
    time: new Date().toLocaleTimeString(),
    ...entry,
  };
  let text = JSON.stringify(record, null, 2);
  for (const key of [apiKeyInput.value]) {
    const secret = key.trim();
    if (secret) text = text.split(secret).join("[REDACTED API KEY]");
  }
  if (text.length > 20000) {
    text = `${text.slice(0, 20000)}\n... [record truncated]`;
  }
  debugEntries.push(text);
  while (debugEntries.length > 200 || debugEntries.join("\n\n").length > 400000) {
    debugEntries.shift();
  }
  debugOutput.textContent = debugEntries.join("\n\n");
  debugCount.textContent = `${debugEntries.length} record(s)`;
  debugOutput.scrollTop = debugOutput.scrollHeight;
}

function clearDebug() {
  debugEntries = [];
  debugOutput.textContent = "Debug output cleared.";
  debugCount.textContent = "0 records";
}

function readSimilarityThreshold(savedValue) {
  const value = Number(savedValue);
  return Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : DEFAULT_SIMILARITY_THRESHOLD;
}

function urlKey(value) {
  const url = String(value || "").trim();
  if (!url) return "";
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return url;
  }
}
