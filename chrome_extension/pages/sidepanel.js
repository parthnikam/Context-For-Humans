import { parseConversationCsv } from "../lib/csv.js";
import { extractConversations } from "../lib/extraction.js";
import {
  askQuestion,
  clearChromaIndex,
  clusterOpenTabs,
  DEFAULT_SIMILARITY_THRESHOLD,
  groupConversations,
  listCategories,
  searchTitles,
  syncProjectAssignments,
  testMem0Service,
  testOpenAIService,
  testTypeSafeService,
  testChromaService,
} from "../lib/grouping.js";
import { openGraphNode } from "../lib/graph-actions.js";
import { renderGraph } from "../lib/graph-view.js";
import { appendGraphData, moveConversation } from "../lib/graph-state.js";
import { mountGraph } from "../lib/graph-force.js";
import { fillGraphDetail } from "../lib/graph-detail.js";
import { tabGraphModel } from "../lib/tab-graph-model.js";
import { providerLogo } from "../lib/provider-logos.js";
import {
  applyChromeGroups,
  focusProjectGroup,
  focusTab,
  isUntitledTitle,
  listChromeGroups,
  mergeTrailGroups,
  openProjectTabs,
  projectGroups,
  pullUntitled,
  shouldSkipUrl,
  ungroupProjectTabs,
} from "../lib/tab-groups.js";
import { runPageAction } from "../lib/page-actions.js";
import { createCsvDownload } from "../lib/csv-download.js";

const STORAGE_KEY = "conversationProjectGraph";
const LEGACY_MEM0_KEY = "conversationMem0ApiKey";
const SIMILARITY_THRESHOLD_KEY = "chromaSimilarityThreshold";
const SUGGESTIONS_KEY = "tabClusterSuggestions";

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
const similarityThresholdInput = document.querySelector("#similarity-threshold");
const downloadButton = document.querySelector("#download");
const debugOutput = document.querySelector("#debug-output");
const debugCount = document.querySelector("#debug-count");
const askAnswer = document.querySelector("#ask-answer");
const askForm = document.querySelector("#ask-form");
const askInput = document.querySelector("#ask-input");
const largerTabButton = document.querySelector("#tab-larger");
const projectsTop = document.querySelector("#projects-top");
const projectsList = document.querySelector("#projects-list");
const projectsGraphStage = document.querySelector("#projects-graph-stage");
const projectsGraphDetail = document.querySelector("#projects-graph-detail");
const projectsFind = document.querySelector("#projects-find");
const projectsListToggle = document.querySelector("#projects-list-toggle");
const projectsGraphToggle = document.querySelector("#projects-graph-toggle");
const chromeGroupsBody = document.querySelector("#chrome-groups-body");

const PANEL_TABS = ["conversations", "projects", "import"];
const panelTabButtons = {
  conversations: document.querySelector("#tab-conversations"),
  projects: document.querySelector("#tab-projects"),
  import: document.querySelector("#tab-import"),
};
const panelTabViews = {
  conversations: document.querySelector("#view-conversations"),
  projects: document.querySelector("#view-projects"),
  import: document.querySelector("#view-import"),
};

let areas = [];
let projects = [];
let conversations = [];
let suggestions = [];
let chromeGroups = null;
let graphSource = "";
let debugEntries = [];
let cancelled = false;
let busy = false;
let migrationPromise = Promise.resolve();
let activeTab = "conversations";
let tabGraphHandle = null;
let projectsViewMode = "list";
let deleteConfirmingId = null;

scanButton.addEventListener("click", detectAreas);
areaSelect.addEventListener("change", selectArea);
extractButton.addEventListener("click", extractAndGroup);
cancelButton.addEventListener("click", () => {
  cancelled = true;
  setStatus("Stopping after the current scroll step...");
});
csvInput.addEventListener("change", importCsv);
downloadButton.addEventListener("click", () => createCsvDownload(conversations));
document.querySelector("#test-openai").addEventListener("click", testOpenAIConnection);
document.querySelector("#test-typesafe").addEventListener("click", testTypeSafeConnection);
document.querySelector("#test-chroma").addEventListener("click", testChromaServiceConnection);
document.querySelector("#test-mem0").addEventListener("click", testMem0Connection);
askForm.addEventListener("submit", handleAsk);
document.querySelector("#clear-graphs").addEventListener("click", clearGraphs);
document.querySelector("#clear-debug").addEventListener("click", clearDebug);
similarityThresholdInput.addEventListener("change", saveSimilarityThreshold);
for (const [name, button] of Object.entries(panelTabButtons)) {
  button.addEventListener("click", () => selectPanelTab(name));
}
largerTabButton.addEventListener("click", () => {
  chrome.tabs
    .create({ url: chrome.runtime.getURL("pages/sidepanel.html?view=large") })
    .catch((error) => setStatus(error.message));
});
if (new URLSearchParams(location.search).get("view") === "large") {
  document.body.classList.add("panel-large");
}
projectsListToggle.addEventListener("click", () => setProjectsViewMode("list"));
projectsGraphToggle.addEventListener("click", () => setProjectsViewMode("graph"));

let projectsSemanticMatches = new Set();
let projectsSearchTimer = 0;
let projectsSearchSequence = 0;

projectsFind.addEventListener("input", () => {
  projectsSemanticMatches = new Set();
  if (projectsViewMode === "list") {
    renderProjectsBrowser();
  } else {
    tabGraphHandle?.redraw();
  }
  window.clearTimeout(projectsSearchTimer);
  const sequence = ++projectsSearchSequence;
  const query = projectsFind.value.trim();
  if (query.length < 2) return;
  projectsSearchTimer = window.setTimeout(async () => {
    try {
      const result = await searchTitles(query, { onDebug: appendDebug });
      if (sequence !== projectsSearchSequence) return;
      projectsSemanticMatches = new Set((Array.isArray(result.matches) ? result.matches : [])
        .map((item) => urlKey(item.url))
        .filter(Boolean));
    } catch {
      if (sequence !== projectsSearchSequence) return;
      projectsSemanticMatches = new Set();
      setStatus(`Similarity search unavailable: ${query}`);
    }
    if (sequence !== projectsSearchSequence) return;
    if (projectsViewMode === "list") {
      renderProjectsBrowser();
    } else {
      tabGraphHandle?.redraw();
      tabGraphHandle?.focusSearch();
    }
  }, 300);
});

function selectPanelTab(name) {
  if (!PANEL_TABS.includes(name)) name = "conversations";
  activeTab = name;
  for (const [tab, button] of Object.entries(panelTabButtons)) {
    button.setAttribute("aria-selected", String(tab === name));
  }
  for (const [tab, view] of Object.entries(panelTabViews)) {
    view.hidden = tab !== name;
  }
  if (name === "projects") {
    renderProjectsView();
  } else {
    destroyTabGraph();
    deleteConfirmingId = null;
  }
}

function setProjectsViewMode(mode) {
  projectsViewMode = mode === "graph" ? "graph" : "list";
  if (activeTab === "projects") renderProjectsView();
}

initialize();

async function initialize() {
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEY, SIMILARITY_THRESHOLD_KEY, SUGGESTIONS_KEY]);
    await chrome.storage.local.remove([LEGACY_MEM0_KEY, "conversationGeminiApiKey"]);
    suggestions = Array.isArray(stored[SUGGESTIONS_KEY]) ? stored[SUGGESTIONS_KEY] : [];
    similarityThresholdInput.value = String(readSimilarityThreshold(stored[SIMILARITY_THRESHOLD_KEY]));
    const saved = stored[STORAGE_KEY];
    if (saved && Array.isArray(saved.projects) && Array.isArray(saved.conversations)) {
      projects = saved.projects;
      conversations = saved.conversations;
      graphSource = String(saved.source || "");
      render();
      if (conversations.length) {
        try {
          const taxonomy = await listCategories({ onDebug: appendDebug });
          const categoryIds = new Set((taxonomy.categories || []).map((item) => item.id));
          if (!projects.length || projects.some((project) => !categoryIds.has(String(project.categoryId || "")))) {
            setStatus("Repairing missing or outdated categories with TypeSafe Jev...");
            setBusy(true);
            migrationPromise = migrateLegacyGraph(stored[SIMILARITY_THRESHOLD_KEY], categoryIds);
            try {
              await migrationPromise;
            } finally {
              setBusy(false);
            }
          } else {
            setStatus(`Loaded ${conversations.length} saved conversation(s).`);
          }
        } catch (error) {
          setStatus(`Could not repair existing categories: ${error.message}`);
        }
      }
    }
  } catch (error) {
    setStatus(`Could not load saved data: ${error.message}`);
  }
  await loadChromeGroups();
}

async function migrateLegacyGraph(savedThreshold, validCategoryIds) {
  const grouped = await groupConversations({
    conversations,
    existingProjects: projects.filter((project) => validCategoryIds.has(project.categoryId)),
    similarityThreshold: readSimilarityThreshold(savedThreshold),
    onDebug: appendDebug,
  });
  const rebuilt = appendGraphData([], [], grouped, conversations);
  await persistGraph(rebuilt.projects, rebuilt.conversations, graphSource);
  projects = rebuilt.projects;
  conversations = rebuilt.conversations;
  render();
  try {
    await syncProjectAssignments(assignmentsForUrls(conversations.map((item) => item.url)), {
      onDebug: appendDebug,
    });
  } catch (error) {
    setStatus(`Categorized the saved graph, but could not update ChromaDB project metadata: ${error.message}`);
    return;
  }
  setStatus(`Categorized the saved graph into ${projects.length} project(s) across ${new Set(projects.map((project) => project.categoryId)).size} category/categories.`);
}

async function testOpenAIConnection() {
  const testButton = document.querySelector("#test-openai");
  testButton.disabled = true;
  setStatus("Testing OpenAI configuration through the local service...");
  try {
    const result = await testOpenAIService({ onDebug: appendDebug });
    setStatus(`OpenAI is ready (${result.model}).`);
  } catch (error) {
    setStatus(error.message);
  } finally {
    testButton.disabled = false;
  }
}

async function testTypeSafeConnection() {
  const button = document.querySelector("#test-typesafe");
  button.disabled = true;
  setStatus("Testing TypeSafe Jev category classifier...");
  try {
    const result = await testTypeSafeService({ onDebug: appendDebug });
    setStatus(`TypeSafe Jev is ready (${result.category} classification test passed).`);
  } catch (error) {
    setStatus(error.message);
  } finally {
    button.disabled = false;
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

async function testMem0Connection() {
  const button = document.querySelector("#test-mem0");
  button.disabled = true;
  setStatus("Testing Mem0 project memory...");
  try {
    await testMem0Service({ onDebug: appendDebug });
    setStatus("Mem0 is ready.");
  } catch (error) {
    setStatus(error.message);
  } finally {
    button.disabled = false;
  }
}

async function handleAsk(event) {
  event.preventDefault();
  const question = askInput.value.trim();
  if (!question) return;
  askInput.value = "";
  const sendButton = askForm.querySelector("button");
  sendButton.disabled = true;
  askInput.disabled = true;
  showAskAnswer("Thinking…", []);
  setStatus("Asking about your projects...");
  try {
    const result = await askQuestion(question, { onDebug: appendDebug });
    showAskAnswer(result.answer, result.sources);
    setStatus("Answered.");
  } catch (error) {
    showAskAnswer(`Could not answer: ${error.message}`, []);
    setStatus(error.message);
  } finally {
    sendButton.disabled = false;
    askInput.disabled = false;
    askInput.focus();
  }
}

function showAskAnswer(text, sources = []) {
  askAnswer.replaceChildren();
  askAnswer.hidden = false;
  askAnswer.append(document.createTextNode(text));
  if (Array.isArray(sources) && sources.length) {
    const sourceList = document.createElement("span");
    sourceList.className = "ask-sources";
    for (const [index, source] of sources.entries()) {
      const link = document.createElement("a");
      link.href = source.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = source.title || source.url;
      link.title = source.url;
      sourceList.append(link);
      if (index < sources.length - 1) sourceList.append(" · ");
    }
    askAnswer.append(sourceList);
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

async function groupAndShow(entries, source, { stay = false, origin = "conversations" } = {}) {
  await migrationPromise;
  const knownUrls = new Set(conversations.map((conversation) => urlKey(conversation.url)));
  const newEntries = entries.filter((entry) => !knownUrls.has(urlKey(entry.url)));
  if (!newEntries.length) {
    setStatus("No new conversations to add; every URL is already in the graph.");
    return;
  }

  const stored = await chrome.storage.local.get([SIMILARITY_THRESHOLD_KEY]);
  const previousIds = new Set(projects.map((project) => project.id));

  const grouped = await groupConversations({
    conversations: newEntries,
    existingProjects: projects,
    similarityThreshold: readSimilarityThreshold(stored[SIMILARITY_THRESHOLD_KEY]),
    onStatus: setStatus,
    onDebug: appendDebug,
  });
  const appended = appendGraphData(projects, conversations, grouped, newEntries);
  const taggedProjects = appended.projects.map((project) => (
    previousIds.has(project.id) || project.origin ? project : { ...project, origin }
  ));
  const nextSource = graphSource
    ? [...new Set([...graphSource.split(", "), source])].filter(Boolean).join(", ")
    : source;
  await persistGraph(taggedProjects, appended.conversations, nextSource);
  conversations = appended.conversations;
  projects = taggedProjects;
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
  if (!stay) selectPanelTab("conversations");
  setStatus(`Added ${newEntries.length} conversation(s); graph now has ${projects.length} project(s) and ${conversations.length} conversation(s).`);
}

function tabProjects() {
  return projects.filter((project) => project.origin === "tabs");
}

async function clearGraphs() {
  if (!confirm("Clear the graph, saved conversations, and local ChromaDB index? This cannot be undone.")) return;
  try {
    await chrome.storage.local.remove(STORAGE_KEY);
  } catch (error) {
    setStatus(`Could not clear the saved graph: ${error.message}`);
    return;
  }
  conversations = [];
  projects = [];
  graphSource = "";
  render();
  try {
    await clearChromaIndex({ onDebug: appendDebug });
    setStatus("Cleared the graph and local ChromaDB title index.");
  } catch (error) {
    setStatus(`Cleared the graph. Could not clear the local ChromaDB index: ${error.message}`);
  }
}

async function editGraph(change) {
  try {
    if (change.type !== "move") {
      throw new Error("Unknown graph edit.");
    }
    const updatedProjects = moveConversation(projects, change.projectId, change.targetProjectId, change.url);
    await persistGraph(updatedProjects, conversations, graphSource);
    projects = updatedProjects;
    try {
      await syncProjectAssignments(
        assignmentsForProjectIds([change.projectId, change.targetProjectId]),
        { onDebug: appendDebug },
      );
    } catch (error) {
      render();
      setStatus(`Graph edit saved, but ChromaDB project metadata could not be updated: ${error.message}`);
      return;
    }
    render();
    setStatus("Conversation moved to the selected project.");
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
        category_id: project.categoryId || "uncategorized",
        category_name: project.categoryName || "Uncategorized",
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
      category_id: project.categoryId || "uncategorized",
      category_name: project.categoryName || "Uncategorized",
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
    {
      search: (query) => searchTitles(query, { onDebug: appendDebug }),
    },
  );
  const projectCount = projects.length;
  counts.textContent = conversations.length
    ? `${projectCount} project(s) · ${conversations.length} conversation(s)`
    : "No data";
  downloadButton.disabled = conversations.length === 0;
  document.querySelector("#clear-graphs").disabled = busy;
  if (activeTab === "projects") renderProjectsView();
}

async function loadChromeGroups() {
  try {
    chromeGroups = await listChromeGroups();
  } catch {
    chromeGroups = null;
  }
}

async function saveSuggestions() {
  try {
    await chrome.storage.local.set({ [SUGGESTIONS_KEY]: suggestions });
  } catch {
    // Suggestions are a convenience; keep going if storage fails.
  }
}

async function groupMyTabs(button) {
  if (busy) return;
  if (!chrome.tabGroups || !chrome.tabGroups.query) {
    setStatus("Tab grouping needs the new permissions. Reload the extension in chrome://extensions, then close and reopen this panel.");
    return;
  }
  busy = true;
  button.disabled = true;
  setStatus("Grouping tabs…");
  try {
    const open = await chrome.tabs.query({});
    const tabs = open.filter((tab) => tab.id != null && !tab.pinned && !shouldSkipUrl(tab.url));
    if (!tabs.length) {
      setStatus("No groupable tabs are open. Pinned and browser-internal tabs are skipped.");
      return;
    }
    let groups = pullUntitled(projectGroups(projects, tabs), tabs);
    const claimed = new Set(groups.flatMap((group) => group.tabIds));
    const loose = tabs.filter((tab) => !claimed.has(tab.id) && !isUntitledTitle(tab.title));
    let warning = "";
    let trails = [];
    if (loose.length) {
      try {
        const result = await clusterOpenTabs(
          loose.map((tab) => ({ id: tab.id, title: tab.title || tab.url || "Untitled", url: tab.url })),
          projects.map((project) => ({ name: project.name, intent: project.intent || "" })),
          { onDebug: appendDebug },
        );
        trails = result.trails || [];
        groups = mergeTrailGroups(groups, trails);
      } catch (error) {
        appendDebug({
          service: "OpenAI",
          stage: "Cluster open tabs",
          direction: "error",
          payload: { message: error.message },
        });
        warning = `Could not cluster ${loose.length} loose tab(s): ${error.message}`;
        if (!groups.length) {
          throw new Error(`${warning} Is the local ChromaDB service running the latest code? Restart it (python -m uvicorn chroma_service.app:app --host 127.0.0.1 --port 8765).`);
        }
      }
    }
    if (!groups.length) {
      setStatus(warning || "No open tabs could be grouped.");
      return;
    }
    const applied = await applyChromeGroups(groups);
    const names = groups.map((group) => group.title).join(", ");
    let filedNote = "";
    if (trails.length) {
      try {
        const filed = await autoAcceptTrails(trails, loose);
        if (filed > 0) filedNote = ` Filed ${filed} group(s) into your projects.`;
        suggestions = [];
      } catch (error) {
        suggestions = suggestionsFromTrails(trails, loose);
        filedNote = ` Could not file them automatically: ${error.message}. Accept the suggestions below.`;
      }
      await saveSuggestions();
    }
    const parts = [`Grouped ${names} in Chrome.`, filedNote, applied.warning, warning].filter(Boolean);
    setStatus(parts.join(" "));
  } catch (error) {
    setStatus(`Could not group tabs: ${error.message}`);
  } finally {
    busy = false;
    button.disabled = false;
    await loadChromeGroups();
    if (activeTab === "projects") renderProjectsView();
  }
}

function suggestionsFromTrails(trails, loose) {
  const tabById = new Map((loose || []).map((tab) => [tab.id, tab]));
  return (trails || [])
    .filter((trail) => (trail.label || "").toLowerCase() !== "ungrouped" && (trail.tab_ids || []).length)
    .map((trail, index) => ({
      id: `suggestion-${index}-${trail.label}`,
      label: trail.label,
      one_liner: trail.one_liner,
      tabs: (trail.tab_ids || [])
        .map((id) => tabById.get(id))
        .filter(Boolean)
        .map((tab) => ({
          id: tab.id,
          title: tab.title || tab.url || "Untitled",
          url: tab.url,
          favIconUrl: "",
        })),
    }))
    .filter((suggestion) => suggestion.tabs.length);
}

async function autoAcceptTrails(trails, loose) {
  const tabById = new Map((loose || []).map((tab) => [tab.id, tab]));
  const filing = (trails || [])
    .filter((trail) => (trail.label || "").toLowerCase() !== "ungrouped" && (trail.tab_ids || []).length)
    .map((trail) => ({
      trail,
      entries: (trail.tab_ids || [])
        .map((id) => tabById.get(id))
        .filter(Boolean)
        .map((tab) => ({ title: tab.title || tab.url || "Untitled", url: tab.url })),
    }))
    .filter((item) => item.entries.length);
  if (!filing.length) return 0;

  const knownBefore = new Set(conversations.map((conversation) => urlKey(conversation.url)));
  const fresh = filing.filter((item) => item.entries.some((entry) => !knownBefore.has(urlKey(entry.url))));
  if (fresh.length) {
    const allEntries = [];
    const seen = new Set();
    for (const item of fresh) {
      for (const entry of item.entries) {
        const key = urlKey(entry.url);
        if (seen.has(key)) continue;
        seen.add(key);
        allEntries.push(entry);
      }
    }
    const labels = filing.map((item) => item.trail.label).join(", ");
    await groupAndShow(allEntries, `Tabs: ${labels}`, { stay: true, origin: "tabs" });
  }

  const claimedProjectIds = new Set();
  const updates = [];
  let marked = 0;
  for (const item of filing) {
    const targetUrls = new Set(item.entries.map((entry) => urlKey(entry.url)));
    const hosts = projects
      .map((project) => ({
        project,
        count: (project.links || []).filter((link) => targetUrls.has(urlKey(link.url))).length,
      }))
      .filter((host) => host.count > 0 && !claimedProjectIds.has(host.project.id))
      .sort((left, right) => right.count - left.count);
    const host = hosts[0];
    if (!host) continue;
    claimedProjectIds.add(host.project.id);
    marked += 1;
    const wantsRename = fresh.includes(item)
      && host.project.name !== item.trail.label
      && !projects.some((project) => project.name === item.trail.label);
    if (host.project.origin === "tabs" && !wantsRename) continue;
    updates.push({
      projectId: host.project.id,
      label: wantsRename ? item.trail.label : host.project.name,
      intent: host.project.intent || (wantsRename ? item.trail.one_liner || "" : ""),
    });
  }
  if (updates.length) {
    const updateById = new Map(updates.map((update) => [update.projectId, update]));
    const updated = projects.map((project) => {
      const update = updateById.get(project.id);
      return update
        ? { ...project, name: update.label, intent: update.intent, origin: "tabs" }
        : project;
    });
    await persistGraph(updated, conversations, graphSource);
    projects = updated;
    render();
    try {
      await syncProjectAssignments(
        assignmentsForProjectIds([...updateById.keys()]),
        { onDebug: appendDebug },
      );
    } catch (error) {
      appendDebug({
        service: "ChromaDB",
        stage: "Save auto-filed projects",
        direction: "error",
        payload: { message: error.message },
      });
    }
  }
  return marked;
}

async function acceptSuggestion(suggestion) {
  if (busy) return;
  setStatus(`Filing "${suggestion.label}"…`);
  const entries = suggestion.tabs.map((tab) => ({ title: tab.title, url: tab.url }));
  const targetUrls = new Set(entries.map((entry) => urlKey(entry.url)));
  try {
    await groupAndShow(entries, `Tabs: ${suggestion.label}`, { origin: "tabs" });
    const hosts = projects
      .map((project) => ({
        project,
        count: (project.links || []).filter((link) => targetUrls.has(urlKey(link.url))).length,
      }))
      .filter((host) => host.count > 0)
      .sort((left, right) => right.count - left.count);
    const host = hosts[0];
    if (host && host.project.name !== suggestion.label && !projects.some((project) => project.name === suggestion.label)) {
      const updated = projects.map((project) => project.id === host.project.id
        ? { ...project, name: suggestion.label, intent: project.intent || suggestion.one_liner, origin: "tabs" }
        : project);
      await persistGraph(updated, conversations, graphSource);
      projects = updated;
      render();
      try {
        await syncProjectAssignments(assignmentsForProjectIds([host.project.id]), { onDebug: appendDebug });
      } catch (error) {
        setStatus(`Filed under "${suggestion.label}", but could not update ChromaDB metadata: ${error.message}`);
      }
    }
    suggestions = suggestions.filter((item) => item.id !== suggestion.id);
    await saveSuggestions();
    setStatus(`Filed "${suggestion.label}".`);
  } catch (error) {
    setStatus(`Could not file "${suggestion.label}": ${error.message}`);
  } finally {
    selectPanelTab("projects");
  }
}

function renderProjectsView() {
  renderProjectsTop();
  renderProjectsBrowser();
  renderChromeGroupsSection();
}

function renderProjectsTop() {
  projectsTop.replaceChildren();
  const actions = document.createElement("div");
  actions.className = "actions";
  const groupButton = document.createElement("button");
  groupButton.type = "button";
  groupButton.className = "primary";
  groupButton.textContent = "Group my tabs";
  groupButton.addEventListener("click", () => groupMyTabs(groupButton));
  actions.append(groupButton);
  projectsTop.append(actions);

  projectsTop.append(sectionLabel("Suggestions"));
  if (!suggestions.length) {
    projectsTop.append(emptyLine("Groups from Group my tabs are filed into your projects automatically."));
  }
  for (const suggestion of suggestions) {
    projectsTop.append(renderSuggestionCard(suggestion));
  }
}

function renderProjectsBrowser() {
  const isList = projectsViewMode === "list";
  const filed = tabProjects();
  projectsListToggle.setAttribute("aria-pressed", String(isList));
  projectsGraphToggle.setAttribute("aria-pressed", String(!isList));
  projectsGraphDetail.hidden = true;
  projectsGraphDetail.replaceChildren();
  if (isList) {
    destroyTabGraph();
    projectsGraphStage.hidden = true;
    projectsList.hidden = false;
    projectsList.replaceChildren();
    const query = projectsFind.value.trim().toLowerCase();
    const semanticActive = projectsSemanticMatches.size > 0;
    const visible = query || semanticActive
      ? filed.filter((project) =>
          (query && (
            (project.name || "").toLowerCase().includes(query)
            || (project.intent || "").toLowerCase().includes(query)
            || (project.links || []).some((link) => (link.title || "").toLowerCase().includes(query))
          ))
          || (semanticActive
            && (project.links || []).some((link) => projectsSemanticMatches.has(urlKey(link.url)))))
      : filed;
    if (!visible.length) {
      projectsList.append(emptyLine(query
        ? "No filed projects match that search."
        : "Nothing filed from tabs yet. Press Group my tabs to file your open tabs."));
    }
    for (const project of visible) {
      projectsList.append(renderProjectCard(project, { semantic: semanticActive }));
    }
    return;
  }
  projectsList.hidden = true;
  projectsList.replaceChildren();
  const nodeCount = filed.length + suggestions.length;
  if (!nodeCount) {
    destroyTabGraph();
    projectsGraphStage.hidden = true;
    projectsList.hidden = false;
    projectsList.append(emptyLine("Nothing filed from tabs yet. Press Group my tabs to file your open tabs."));
    return;
  }
  projectsGraphStage.hidden = false;
  mountProjectsGraph();
}

function renderChromeGroupsSection() {
  chromeGroupsBody.replaceChildren();
  if (!chromeGroups) return;
  chromeGroupsBody.append(sectionLabel("Chrome tab groups"));
  const filedNames = new Set(tabProjects().map((project) => (project.name || "").trim().toLowerCase()));
  let shown = 0;
  for (const group of chromeGroups.groups || []) {
    if (filedNames.has((group.title || "").trim().toLowerCase())) continue;
    chromeGroupsBody.append(renderChromeGroupCard(group));
    shown += 1;
  }
  if ((chromeGroups.loose || []).length) {
    chromeGroupsBody.append(renderChromeGroupCard({ title: "Ungrouped", color: "grey", tabs: chromeGroups.loose }));
    shown += 1;
  }
  if (!shown) chromeGroupsBody.append(emptyLine("No Chrome tab groups right now. Press Group my tabs."));
}

function renderSuggestionCard(suggestion) {
  const card = document.createElement("article");
  card.className = "card";
  const title = document.createElement("h2");
  title.textContent = suggestion.label;
  const line = document.createElement("p");
  line.className = "one-liner";
  line.textContent = suggestion.one_liner;
  const list = document.createElement("ul");
  list.className = "tabs";
  for (const tab of suggestion.tabs) {
    list.append(tabRow(tab, { openable: false }));
  }
  const accept = document.createElement("button");
  accept.type = "button";
  accept.className = "primary";
  accept.textContent = "Accept";
  accept.addEventListener("click", () => acceptSuggestion(suggestion));
  card.append(title, line, list, accept);
  return card;
}

function renderProjectCard(project, { semantic = false } = {}) {
  const card = document.createElement("article");
  card.className = "card";
  const head = document.createElement("div");
  head.className = "project-head";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "project-open";
  open.textContent = project.name || "Untitled";
  open.addEventListener("click", () => {
    focusProjectGroup(project.name).then((focused) => {
      if (focused) {
        setStatus(`Opened ${project.name}.`);
        return;
      }
      return openProjectTabs(project).then(
        (result) => setStatus(`Opened ${result.name}.`),
        (error) => setStatus(error.message),
      );
    }).catch((error) => setStatus(error.message));
  });
  const title = document.createElement("h2");
  title.append(open);
  head.append(title);
  if (project.intent) head.append(infoMark(project.intent));
  head.append(deleteProjectControl(project));
  const count = document.createElement("p");
  count.className = "meta";
  const total = (project.links || []).length;
  count.textContent = total === 1 ? "1 link" : `${total} links`;
  const list = document.createElement("ul");
  list.className = "tabs";
  for (const link of project.links || []) {
    const semanticMatch = semantic && projectsSemanticMatches.has(urlKey(link.url));
    list.append(tabRow(link, { openable: true, semanticMatch }));
  }
  card.append(head, count, list);
  return card;
}

function deleteProjectControl(project) {
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "project-delete";
  const confirming = deleteConfirmingId === project.id;
  if (confirming) remove.classList.add("confirming");
  remove.title = confirming ? "Click again to delete" : "Delete project (tabs stay open)";
  remove.setAttribute("aria-label", confirming ? `Confirm deleting ${project.name}` : `Delete ${project.name}`);
  remove.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5h10M6.3 4.5V3.2h3.4v1.3M4.3 4.5l.5 8.3h6.4l.5-8.3M6.6 7v3.4M9.4 7v3.4"/></svg>';
  remove.addEventListener("click", () => {
    if (deleteConfirmingId !== project.id) {
      deleteConfirmingId = project.id;
      renderProjectsBrowser();
      return;
    }
    deleteConfirmingId = null;
    deleteTabProject(project);
  });
  return remove;
}

async function deleteTabProject(project) {
  setStatus(`Removing ${project.name}…`);
  try {
    const urls = new Set((project.links || []).map((link) => urlKey(link.url)));
    const updatedProjects = projects.filter((item) => item.id !== project.id);
    const updatedConversations = conversations.filter((item) => !urls.has(urlKey(item.url)));
    await persistGraph(updatedProjects, updatedConversations, graphSource);
    projects = updatedProjects;
    conversations = updatedConversations;
    render();
    let note = `Removed ${project.name}.`;
    try {
      const ungrouped = await ungroupProjectTabs(project.name);
      if (ungrouped) note = `Removed ${project.name} and ungrouped ${ungrouped} tab(s). The tabs stay open.`;
    } catch (error) {
      note = `Removed ${project.name}, but could not ungroup its Chrome tabs: ${error.message}`;
    }
    setStatus(note);
  } catch (error) {
    setStatus(`Could not remove ${project.name}: ${error.message}`);
  } finally {
    await loadChromeGroups();
    if (activeTab === "projects") renderProjectsView();
  }
}

function renderChromeGroupCard(group) {
  const card = document.createElement("article");
  card.className = "card";
  const head = document.createElement("div");
  head.className = "project-head";
  const swatch = document.createElement("span");
  swatch.className = "group-swatch";
  swatch.dataset.color = group.color || "grey";
  const title = document.createElement("h2");
  title.textContent = group.title || "Untitled";
  head.append(swatch, title);
  const count = document.createElement("p");
  count.className = "meta";
  const total = (group.tabs || []).length;
  count.textContent = total === 1 ? "1 tab" : `${total} tabs`;
  const list = document.createElement("ul");
  list.className = "tabs";
  for (const tab of group.tabs || []) {
    list.append(tabRow(tab, { openable: true }));
  }
  card.append(head, count, list);
  return card;
}

function tabRow(item, { openable, semanticMatch = false }) {
  const li = document.createElement("li");
  const row = document.createElement(openable ? "button" : "div");
  if (openable) row.type = "button";
  row.className = openable ? "tab" : "tab static";
  if (semanticMatch) row.classList.add("semantic-match");
  const logo = providerLogo(item.url);
  if (logo) row.append(logo);
  const copy = document.createElement("span");
  copy.className = "tab-copy";
  const label = document.createElement("span");
  label.className = "tab-title";
  label.textContent = item.title || item.url || "Untitled";
  label.title = item.title || "";
  copy.append(label);
  row.append(copy);
  if (openable && Number.isInteger(item.id)) {
    row.addEventListener("click", () => {
      focusTab(item.id).catch((error) => setStatus(error.message));
    });
  } else if (openable) {
    row.addEventListener("click", () => {
      chrome.tabs.create({ url: item.url, active: true }).catch((error) => setStatus(error.message));
    });
  }
  li.append(row);
  return li;
}

function infoMark(text) {
  const info = document.createElement("span");
  info.className = "info";
  const mark = document.createElement("button");
  mark.type = "button";
  mark.className = "info-mark";
  mark.textContent = "i";
  mark.setAttribute("aria-label", "Project description");
  const tip = document.createElement("span");
  tip.className = "info-tip";
  tip.setAttribute("role", "tooltip");
  tip.textContent = text;
  info.append(mark, tip);
  return info;
}

function sectionLabel(text) {
  const heading = document.createElement("h2");
  heading.className = "section-label";
  heading.textContent = text;
  return heading;
}

function emptyLine(text) {
  const paragraph = document.createElement("p");
  paragraph.className = "empty";
  paragraph.textContent = text;
  return paragraph;
}

function mountProjectsGraph() {
  destroyTabGraph();
  projectsGraphDetail.hidden = true;
  projectsGraphDetail.replaceChildren();
  tabGraphHandle = mountGraph(projectsGraphStage, tabGraphModel({ projects: tabProjects(), suggestions }), {
    nodeScale: 1.7,
    rootKinds: ["project", "suggestion"],
    revealRanges: { link: [0.8, 1.1] },
    getQuery: () => projectsFind.value.trim(),
    getSemanticMatches: () => projectsSemanticMatches,
    onSelect: (node) => {
      if (!node) {
        projectsGraphDetail.hidden = true;
        projectsGraphDetail.replaceChildren();
        return;
      }
      fillGraphDetail(projectsGraphDetail, node, tabGraphOpen, projects);
    },
    onOpen: tabGraphOpen,
  });
}

function destroyTabGraph() {
  tabGraphHandle?.destroy();
  tabGraphHandle = null;
}

function tabGraphOpen(node) {
  if (!node) return;
  if (node.kind === "link") {
    chrome.tabs.create({ url: node.url, active: true }).catch((error) => setStatus(error.message));
    return;
  }
  if (node.kind === "suggestion") {
    setStatus(node.intent || node.label);
    return;
  }
  const project = projects.find((item) => item.id === node.id);
  if (project) {
    openProjectTabs(project).then(
      (result) => setStatus(`Opened ${result.name}.`),
      (error) => setStatus(error.message),
    );
  }
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
  document.querySelector("#clear-graphs").disabled = next;
  if (!next) cancelButton.hidden = true;
}

async function runOnActiveTab(action) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error("No active tab is available.");
  if (/^(chrome|edge|about|devtools|view-source):/i.test(tab.url || "")) {
    throw new Error("Browser-internal pages cannot be scanned. Open your chat page in a normal tab and try again.");
  }
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
