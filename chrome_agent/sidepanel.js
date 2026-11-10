import { parseConversationCsv } from "./csv.js";
import { extractConversations } from "./extraction.js";
import { groupConversations, testGeminiKey, testMem0Key } from "./grouping.js";
import { openGraphNode } from "./graph-actions.js";
import { renderGraph } from "./graph-view.js";
import { moveConversation, renameProject } from "./graph-state.js";
import { runPageAction } from "./page-actions.js";
import { createCsvDownload } from "./csv-download.js";

const STORAGE_KEY = "conversationProjectGraph";
const GEMINI_KEY = "conversationGeminiApiKey";
const MEM0_KEY = "conversationMem0ApiKey";

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
const mem0ApiKeyInput = document.querySelector("#mem0-api-key");
const downloadButton = document.querySelector("#download");
const viewLargerLink = document.querySelector("#view-larger");

let areas = [];
let projects = [];
let conversations = [];
let graphSource = "";
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
document.querySelector("#mem0-key-form").addEventListener("submit", saveMem0ApiKey);
document.querySelector("#test-mem0-key").addEventListener("click", testMem0ApiKey);
document.querySelector("#test-gemini-key").addEventListener("click", testGeminiApiKey);
document.querySelector("#clear-graphs").addEventListener("click", clearGraphs);
document.querySelector("#settings-toggle").addEventListener("click", () => {
  settings.open = !settings.open;
  document.querySelector("#settings-toggle").setAttribute("aria-expanded", String(settings.open));
});

initialize();

async function initialize() {
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEY, GEMINI_KEY, MEM0_KEY]);
    apiKeyInput.value = String(stored[GEMINI_KEY] || "");
    mem0ApiKeyInput.value = String(stored[MEM0_KEY] || "");
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

async function saveMem0ApiKey(event) {
  event.preventDefault();
  const key = mem0ApiKeyInput.value.trim();
  if (!key) {
    setStatus("Enter a Mem0 API key to save.");
    return;
  }
  try {
    await chrome.storage.local.set({ [MEM0_KEY]: key });
    setStatus("Mem0 API key saved locally.");
  } catch (error) {
    setStatus(`Could not save Mem0 API key: ${error.message}`);
  }
}

async function testMem0ApiKey() {
  const key = mem0ApiKeyInput.value.trim();
  if (!key) {
    setStatus("Enter a Mem0 API key to test.");
    mem0ApiKeyInput.focus();
    return;
  }
  const testButton = document.querySelector("#test-mem0-key");
  testButton.disabled = true;
  setStatus("Testing Mem0 API key...");
  try {
    await testMem0Key(key);
    setStatus("Mem0 API key works.");
  } catch (error) {
    setStatus(error.message);
  } finally {
    testButton.disabled = false;
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
    if (result.restoreError) setStatus(`Grouped conversations. Could not restore scroll position: ${result.restoreError}`);
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
  const stored = await chrome.storage.local.get([GEMINI_KEY, MEM0_KEY]);
  const geminiApiKey = String(stored[GEMINI_KEY] || "").trim();
  const mem0ApiKey = String(stored[MEM0_KEY] || "").trim();
  if (!mem0ApiKey || !geminiApiKey) {
    settings.open = true;
    const missingService = !mem0ApiKey ? "Mem0" : "Gemini";
    (!mem0ApiKey ? mem0ApiKeyInput : apiKeyInput).focus();
    throw new Error(`Save a ${missingService} API key in AI grouping settings to create project groups.`);
  }

  const grouped = await groupConversations({
    mem0ApiKey,
    geminiApiKey,
    conversations: entries,
    onStatus: setStatus,
  });
  await persistGraph(grouped, entries, source);
  conversations = entries;
  projects = grouped;
  graphSource = source;
  render();
  setStatus(`Created ${projects.length} project group(s) from ${conversations.length} conversations.`);
}

async function clearGraphs() {
  if (!conversations.length && !projects.length) return;
  if (!confirm("Clear all saved conversations and project connections? This cannot be undone.")) return;
  try {
    await chrome.storage.local.remove(STORAGE_KEY);
    conversations = [];
    projects = [];
    graphSource = "";
    render();
    setStatus("Cleared all project graphs and conversation connections.");
  } catch (error) {
    setStatus(`Could not clear graphs: ${error.message}`);
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
