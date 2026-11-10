import { mountErrorBox } from "./lib/errors.js";
import { dedupeLinks, samePage } from "./lib/groups.js";
import { directTitle, isQuestion, isStopCommand } from "./lib/watch.js";
import { graphModel } from "./lib/graph-model.js";
import { fillGraphDetail, mountGraph } from "./lib/graph-view.js";
import { toView } from "./lib/notebook.js";
import {
  acceptSuggestion,
  childProjects,
  createPreview,
  moveLink,
  projectPath,
  removeLink,
  removeProject,
  renameProject,
  topLevelProjects,
} from "./lib/preview.js";

const viewRoot = document.querySelector("#view");
const status = document.querySelector("#status");
const source = document.querySelector("#source");
const viewButtons = [...document.querySelectorAll(".views button")];

const VIEWS = new Set(["projects", "timeline", "active", "graph"]);
const requested = new URLSearchParams(location.search).get("view");
const ui = {
  live: Boolean(globalThis.chrome?.runtime?.id),
  view: VIEWS.has(requested) ? requested : "projects",
  movingLinkId: null,
  renamingId: null,
  confirmingRemoveId: null,
  busy: false,
  answer: null,
  graph: null,
  watching: null,
  state: createPreview(),
};

document.querySelector("#options").addEventListener("click", () => {
  if (globalThis.chrome?.runtime?.openOptionsPage) chrome.runtime.openOptionsPage();
});

for (const button of viewButtons) {
  button.addEventListener("click", () => {
    if (button.dataset.view !== "projects") cancelVoice();
    ui.view = button.dataset.view;
    ui.movingLinkId = null;
    ui.renamingId = null;
    ui.confirmingRemoveId = null;
    render();
  });
}

document.querySelector("#ask").addEventListener("submit", (event) => {
  event.preventDefault();
  cancelVoice();
  ask(document.querySelector("#question").value);
});

let loadTick = 0;
const showError = mountErrorBox(document.querySelector("#errors"));
const voiceButton = document.querySelector("#voice");
let voiceToken = 0;
let voiceRecognition = null;

voiceButton.addEventListener("click", onVoice);
window.addEventListener("pagehide", () => cancelVoice());

function failStatus(response, fallback) {
  const message = response?.error || fallback;
  setStatus(message);
  showError(message, response?.stack || "");
}

if (ui.live) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "internal-error") {
      showError(message.message, message.stack, message.where);
      return;
    }
    if (message?.type === "groups-changed") {
      if (ui.renamingId || ui.confirmingRemoveId || ui.movingLinkId) return;
      loadLive();
      return;
    }
    if (message?.type !== "tab-filed") return;
    setStatus(`Added ${message.title} to ${message.project}.`);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!changes.notebook && !changes.activeProjectId) return;
    if (ui.renamingId || ui.confirmingRemoveId) return;
    loadLive();
  });
  loadLive();
} else {
  render();
}

function setStatus(text) {
  status.textContent = text;
}

function render() {
  ui.graph?.destroy();
  ui.graph = null;
  document.body.classList.remove("graph-open");
  for (const button of viewButtons) {
    button.setAttribute("aria-selected", String(button.dataset.view === ui.view));
  }
  document.querySelector("#ask").hidden = ui.view !== "projects";
  paintWatching();
  viewRoot.replaceChildren();
  if (ui.view === "projects" && ui.answer) viewRoot.append(renderAnswer(ui.answer));
  if (ui.view === "projects") renderProjects();
  else if (ui.view === "timeline") renderTimeline();
  else if (ui.view === "graph") renderGraph();
  else renderActive();
}

async function loadLive() {
  const tick = ++loadTick;
  const response = await chrome.runtime.sendMessage({ type: "get-state" });
  if (tick !== loadTick) return;
  if (!response?.ok) {
    failStatus(response, "Could not load the notebook.");
    return;
  }
  ui.state = toView(response.result.notebook, response.result.cluster, response.result.tabs);
  ui.state.groups = response.result.groups || [];
  ui.state.loose = response.result.loose || [];
  ui.watching = response.result.activeProject || null;
  if (source) source.textContent = "Saved on this computer";
  render();
}

function paintWatching() {
  const host = document.querySelector("#watching");
  host.replaceChildren();
  if (!ui.watching?.name) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  const name = document.createElement("strong");
  name.textContent = ui.watching.name;
  host.append("Watching ", name, ". Related tabs join this group. ");
  const stop = document.createElement("button");
  stop.type = "button";
  stop.className = "text";
  stop.textContent = "Stop";
  stop.addEventListener("click", () => stopWatching());
  host.append(stop);
}

async function stopWatching() {
  if (!ui.live) {
    ui.watching = null;
    ui.answer = { text: "Stopped. New tabs will stay where they are.", sources: [] };
    ui.view = "projects";
    setStatus("Sample. Watching is off.");
    render();
    return;
  }
  const response = await chrome.runtime.sendMessage({ type: "clear-working-project" });
  if (!response?.ok) {
    failStatus(response, "Could not stop.");
    return;
  }
  ui.answer = { text: response.result.text, sources: [] };
  ui.view = "projects";
  setStatus(response.result.text);
  await loadLive();
}

async function ask(question, options = {}) {
  const text = String(question || "").trim();
  if (!text) {
    setStatus("Type a question first.");
    return;
  }
  if (!ui.live) {
    if (isStopCommand(text)) {
      await stopWatching();
      return;
    }
    const title = !isQuestion(text) ? directTitle(text) : "";
    if (title) {
      ui.watching = { id: "preview", name: title };
      ui.answer = { text: `Watching ${title}. Related tabs join that group, and links opened in it are remembered.`, sources: [] };
      ui.view = "projects";
      document.querySelector("#question").value = "";
      setStatus("Sample. This page cannot group Chrome tabs.");
      render();
      return;
    }
    ui.answer = sampleAnswer(text);
    ui.view = "projects";
    setStatus("Sample answer from this page.");
    render();
    return;
  }
  setStatus("Thinking…");
  const response = await chrome.runtime.sendMessage({ type: "ask-memory", question: text });
  if (!response?.ok) {
    failStatus(response, "Could not answer that.");
    if (voiceButton.dataset.state === "thinking") setVoice("idle");
    return;
  }
  ui.answer = response.result;
  ui.view = "projects";
  if (response.result.error) showError(response.result.error, response.result.stack || "", "ask");
  const spoken = response.result.text || "";
  if (voiceButton.dataset.state === "thinking") setVoice("idle");
  if (response.result.watching || response.result.stopped) {
    document.querySelector("#question").value = "";
    setStatus(response.result.warning || response.result.text);
    await loadLive();
    if (options.speak) speakText(spoken);
    return;
  }
  const filed = response.result.filed ? "Filed into the project. " : "";
  setStatus(`${filed}${response.result.warning || "Answered from what you filed."}`.trim());
  if (response.result.filed) await loadLive();
  else render();
  if (options.speak) speakText(spoken);
}

function setVoice(state) {
  voiceButton.dataset.state = state;
  voiceButton.setAttribute("aria-label", state === "listening" ? "Stop" : state === "speaking" ? "Stop speaking" : "Talk");
  voiceButton.setAttribute("aria-pressed", state === "listening" ? "true" : "false");
}

function cancelVoice() {
  voiceToken += 1;
  voiceRecognition?.abort();
  voiceRecognition = null;
  globalThis.speechSynthesis?.cancel();
  markSpeaker(false);
  setVoice("idle");
}

function girlVoice() {
  const voices = globalThis.speechSynthesis?.getVoices() || [];
  const female = /female|woman|zira|samantha|victoria|karen|moira|tessa|fiona|susan|hazel|aria|jenny|natasha/;
  const ranked = voices.filter((voice) => female.test(voice.name.toLowerCase()));
  return ranked.find((voice) => voice.lang?.toLowerCase().startsWith("en")) || ranked[0] || null;
}

function markSpeaker(on) {
  const button = document.querySelector("#speaker");
  if (!button) return;
  button.dataset.state = on ? "speaking" : "idle";
  button.setAttribute("aria-pressed", on ? "true" : "false");
  button.setAttribute("aria-label", on ? "Stop reading" : "Read answer");
}

function speakText(text) {
  const spoken = String(text || "").trim();
  const synth = globalThis.speechSynthesis;
  if (!spoken || !synth || voiceButton.dataset.state === "listening") return;
  const start = () => {
    if (voiceButton.dataset.state === "listening") return;
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(spoken);
    const voice = girlVoice();
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
    markSpeaker(true);
    utterance.onend = () => markSpeaker(false);
    utterance.onerror = () => markSpeaker(false);
    synth.speak(utterance);
  };
  if (synth.getVoices().length) start();
  else {
    const ready = () => {
      synth.removeEventListener("voiceschanged", ready);
      start();
    };
    synth.addEventListener("voiceschanged", ready);
    synth.getVoices();
  }
}

function onVoice() {
  const state = voiceButton.dataset.state;
  if (state === "thinking") return;
  if (state === "speaking") {
    globalThis.speechSynthesis?.cancel();
    setVoice("idle");
    return;
  }
  if (state === "listening") {
    voiceRecognition?.stop();
    return;
  }
  if (!ui.live) {
    setStatus("Open the side panel in Chrome to talk.");
    return;
  }
  startTalking();
}

async function micPermission() {
  try {
    return (await navigator.permissions.query({ name: "microphone" })).state;
  } catch {
    return "prompt";
  }
}

async function ensureMic(token) {
  if ((await micPermission()) === "granted") return true;
  setStatus("Allow the microphone in the tab Chrome opened. Choose Allow.");
  const response = await chrome.runtime.sendMessage({ type: "request-mic" });
  if (token !== voiceToken) return false;
  const again = await micPermission();
  if (response?.ok && again === "granted") return true;
  setVoice("idle");
  if (!response?.ok) failStatus(response, "Could not ask for the microphone.");
  else if (again === "denied") {
    setStatus("Microphone is blocked. On that tab, use the tune icon, set Microphone to Allow, then click the mic again.");
  } else {
    setStatus("Choose Allow on the microphone prompt, then click the mic again.");
  }
  return false;
}

async function startTalking() {
  if (!ui.live) {
    setStatus("Open the side panel in Chrome to talk.");
    return;
  }
  const Speech = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  if (!Speech) {
    setStatus("This Chrome cannot hear speech in the side panel.");
    return;
  }
  const token = ++voiceToken;
  globalThis.speechSynthesis?.cancel();
  markSpeaker(false);
  setVoice("thinking");
  if (!(await ensureMic(token))) return;
  if (token !== voiceToken) return;
  const recognition = new Speech();
  voiceRecognition = recognition;
  recognition.interimResults = true;
  let sent = false;
  const finishTalk = (transcript) => {
    if (sent || token !== voiceToken) return;
    const heard = String(transcript || "").trim();
    if (!heard) return;
    sent = true;
    setVoice("thinking");
    ask(heard, { speak: true });
  };
  recognition.onresult = (event) => {
    if (token !== voiceToken) return;
    let text = "";
    for (let i = 0; i < event.results.length; i++) text += event.results[i][0].transcript;
    document.querySelector("#question").value = text.trim();
    if (event.results[event.results.length - 1].isFinal) finishTalk(text);
  };
  recognition.onerror = (event) => {
    if (token !== voiceToken || event.error === "aborted" || event.error === "no-speech") return;
    setVoice("idle");
    setStatus(event.error === "not-allowed" ? "Allow the microphone, then click the mic again." : "Didn't catch that.");
  };
  recognition.onend = () => {
    if (voiceRecognition === recognition) voiceRecognition = null;
    if (token !== voiceToken || sent) return;
    const transcript = document.querySelector("#question").value.trim();
    if (transcript) finishTalk(transcript);
    else {
      setVoice("idle");
      setStatus("Didn't catch that.");
    }
  };
  setVoice("listening");
  setStatus("Listening…");
  const cap = setTimeout(() => recognition.stop(), 30000);
  recognition.addEventListener("end", () => clearTimeout(cap));
  try {
    recognition.start();
  } catch (error) {
    clearTimeout(cap);
    setVoice("idle");
    setStatus(error?.message || "Could not start listening.");
  }
}

function sampleAnswer(question) {
  const words = String(question || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 3);
  const links = ui.state.projects.flatMap((project) =>
    (project.links || []).map((link) => ({ title: link.title, url: link.url, project: project.name })),
  );
  const hits = links.filter((link) => {
    const hay = `${link.title} ${link.project} ${link.url}`.toLowerCase();
    return words.some((word) => hay.includes(word));
  });
  const shown = hits.slice(0, 6);
  const names = [...new Set(shown.map((link) => link.project))];
  return {
    text: shown.length
      ? `In ${names.join(" and ")}, you saved ${shown.map((link) => link.title).join(", ")}.`
      : "Nothing in the sample notebook matches that.",
    sources: shown.map((link) => ({ title: link.title, url: link.url })),
    projects: names,
  };
}

function renderAnswer(answer) {
  const card = document.createElement("article");
  card.className = "card";
  const head = document.createElement("div");
  head.className = "answer-head";
  const title = document.createElement("h2");
  title.textContent = "Answer";
  const speaker = document.createElement("button");
  speaker.id = "speaker";
  speaker.type = "button";
  speaker.className = "speaker";
  speaker.dataset.state = "idle";
  speaker.setAttribute("aria-label", "Read answer");
  speaker.setAttribute("aria-pressed", "false");
  speaker.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 6.5v3h2.2L9 12.2V3.8L5.2 6.5H3z" fill="currentColor"/><path d="M10.2 6.2a2.6 2.6 0 0 1 0 3.6M11.6 4.6a5 5 0 0 1 0 6.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;
  speaker.addEventListener("click", () => {
    if (speaker.dataset.state === "speaking") {
      globalThis.speechSynthesis?.cancel();
      markSpeaker(false);
      return;
    }
    speakText(answer.text);
  });
  head.append(title, speaker);
  const body = document.createElement("p");
  body.className = "answer";
  body.textContent = answer.text;
  card.append(head, body);
  const sources = (answer.sources || []).filter((source) => source?.url);
  if (sources.length) {
    const row = document.createElement("div");
    row.className = "sources";
    for (const source of sources) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "source";
      appendFavicon(chip, source);
      const label = document.createElement("span");
      label.className = "tab-title";
      label.textContent = source.title || source.url;
      label.title = source.title || source.url || "";
      chip.append(label);
      chip.addEventListener("click", () => openSavedLink(source));
      row.append(chip);
    }
    card.append(row);
  }
  return card;
}

function renderProjects() {
  viewRoot.append(renderGroupButton());
  viewRoot.append(sectionLabel("Suggestions"));
  if (ui.state.suggestions.length === 0) {
    viewRoot.append(empty("No suggestions. Group the active tabs to make one."));
  }
  for (const suggestion of ui.state.suggestions) {
    viewRoot.append(renderSuggestion(suggestion));
  }
  viewRoot.append(sectionLabel("Filed"));
  const filedNames = new Set(
    (ui.state.projects || []).map((project) => String(project.name || "").trim().toLowerCase()),
  );
  for (const project of topLevelProjects(ui.state)) {
    viewRoot.append(renderProject(project));
  }
  if (!ui.live) return;
  for (const group of ui.state.groups || []) {
    if (filedNames.has(String(group.title || "").trim().toLowerCase())) continue;
    viewRoot.append(renderChromeGroup(group));
  }
  if ((ui.state.loose || []).length) {
    viewRoot.append(renderChromeGroup({ title: "Ungrouped", color: "grey", tabs: ui.state.loose }));
  }
}

function renderSuggestion(suggestion) {
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
    list.append(renderLinkRow(tab, { movable: false }));
  }

  const accept = document.createElement("button");
  accept.type = "button";
  accept.className = "primary";
  accept.textContent = "Accept";
  accept.addEventListener("click", () => {
    if (ui.live) {
      fileSuggestion(suggestion);
      return;
    }
    ui.state = acceptSuggestion(ui.state, suggestion.id);
    setStatus(`Filed “${suggestion.label}” as a project.`);
    render();
  });

  card.append(title, line, list, accept);
  return card;
}

function renderProject(project) {
  const card = document.createElement("article");
  card.className = "card";
  card.append(projectBody(project));
  for (const child of childProjects(ui.state, project.id)) {
    const nested = document.createElement("div");
    nested.className = "subproject";
    nested.append(projectBody(child));
    card.append(nested);
  }
  return card;
}

function projectBody(project) {
  const links = dedupeLinks(project.links || []);
  const wrap = document.createElement("div");
  const head = document.createElement("div");
  head.className = "project-head";
  const title = document.createElement("h2");
  if (ui.renamingId === project.id) title.append(renameField(project));
  else {
    const open = document.createElement("button");
    open.type = "button";
    open.className = "project-open";
    open.textContent = project.name;
    open.addEventListener("click", () => openFiledProject({ ...project, links }));
    title.append(open);
  }
  head.append(title);
  if (project.intent) head.append(infoMark(project.intent));
  head.append(projectActions(project));
  const count = document.createElement("p");
  count.className = "meta";
  const total = links.length;
  count.textContent = total === 1 ? "1 link" : `${total} links`;
  const list = document.createElement("ul");
  list.className = "tabs";
  for (const link of links) {
    list.append(renderLinkRow(link, { movable: true, projectId: project.id, openable: true }));
  }
  const groupName = String(project.name || "").trim().toLowerCase();
  const openTabs = (ui.state.groups || [])
    .filter((group) => String(group.title || "").trim().toLowerCase() === groupName)
    .flatMap((group) => group.tabs || [])
    .filter((tab) => !links.some((link) => samePage(link.url, tab.url)));
  for (const tab of openTabs) list.append(renderOpenTab(tab));
  wrap.append(head, count, list);
  return wrap;
}

function renameField(project) {
  const form = document.createElement("form");
  form.className = "project-rename";
  const input = document.createElement("input");
  input.type = "text";
  input.value = project.name;
  input.setAttribute("aria-label", "Project name");
  form.append(input);
  let done = false;
  const cancel = () => {
    if (done) return;
    done = true;
    ui.renamingId = null;
    render();
  };
  const finish = (value) => {
    if (done) return;
    done = true;
    const next = String(value || "").trim();
    if (!next || next === project.name) {
      ui.renamingId = null;
      render();
      return;
    }
    commitRename(project, next);
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    finish(input.value);
  });
  input.addEventListener("blur", () => finish(input.value));
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    cancel();
  });
  queueMicrotask(() => {
    if (ui.renamingId !== project.id) return;
    input.focus();
    input.select();
  });
  return form;
}

function projectActions(project) {
  const actions = document.createElement("div");
  actions.className = "project-actions";
  const rename = document.createElement("button");
  rename.type = "button";
  rename.className = "text";
  rename.textContent = "Rename";
  rename.addEventListener("click", () => {
    ui.renamingId = project.id;
    ui.confirmingRemoveId = null;
    render();
  });
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "text";
  const confirming = ui.confirmingRemoveId === project.id;
  remove.textContent = confirming ? "Delete" : "Remove";
  if (confirming) remove.classList.add("danger");
  remove.addEventListener("click", () => {
    if (ui.confirmingRemoveId !== project.id) {
      ui.confirmingRemoveId = project.id;
      ui.renamingId = null;
      render();
      return;
    }
    removeFiledProject(project);
  });
  actions.append(rename, remove);
  return actions;
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

function renderLinkRow(link, { movable, projectId, openable }) {
  const item = document.createElement("li");
  const line = document.createElement("div");
  line.className = "tab-line";
  const row = document.createElement(openable ? "button" : "div");
  if (openable) row.type = "button";
  row.className = openable ? "tab" : "tab static";
  appendFavicon(row, link);

  const copy = document.createElement("span");
  copy.className = "tab-copy";
  const label = document.createElement("span");
  label.className = "tab-title";
  label.textContent = link.title;
  label.title = link.title || "";
  copy.append(label);
  row.append(copy);
  if (openable) row.addEventListener("click", () => openSavedLink(link, projectId));
  line.append(row);

  if (movable) line.append(renderMoveControl(link, projectId));

  item.append(line);
  if (movable && ui.movingLinkId === link.id) {
    item.append(renderMoveChoices(link.id, projectId));
  }
  return item;
}

function renderMoveControl(link, projectId) {
  const actions = document.createElement("div");
  actions.className = "tab-actions";

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "tab-remove";
  remove.setAttribute("aria-label", "remove");
  remove.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.2 4.5h9.6M6.2 4.4V3.2h3.6v1.2M4.4 4.5l.5 8.3h6.2l.5-8.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  remove.addEventListener("click", () => {
    if (ui.live) {
      fileRemove(link);
      return;
    }
    ui.state = removeLink(ui.state, link.id);
    ui.movingLinkId = null;
    setStatus(`Removed ${link.title || "that tab"} from the project.`);
    render();
  });

  const move = document.createElement("button");
  move.type = "button";
  move.className = "tab-move";
  move.textContent = "move";
  move.addEventListener("click", () => {
    ui.movingLinkId = ui.movingLinkId === link.id ? null : link.id;
    render();
  });

  actions.append(remove, move);
  return actions;
}

function renderMoveChoices(linkId, projectId) {
  const row = document.createElement("div");
  row.className = "move-row";
  const others = ui.state.projects.filter((project) => project.id !== projectId);
  for (const project of others) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = projectPath(ui.state, project.id);
    button.addEventListener("click", () => {
      if (ui.live) {
        fileMove(linkId, project.id, projectPath(ui.state, project.id));
        return;
      }
      ui.state = moveLink(ui.state, linkId, project.id);
      ui.movingLinkId = null;
      setStatus(`Moved to ${projectPath(ui.state, project.id)}.`);
      render();
    });
    row.append(button);
  }
  return row;
}

function renderGraph() {
  document.body.classList.add("graph-open");
  const stage = document.createElement("div");
  stage.className = "graph-stage";
  const model = graphModel(ui.state);
  if (!model.nodes.length) {
    stage.append(empty("File a project and it will show up here."));
    viewRoot.append(stage);
    return;
  }
  const canvas = document.createElement("canvas");
  canvas.className = "graph-canvas";
  const find = document.createElement("input");
  find.type = "search";
  find.className = "graph-find";
  find.placeholder = "Find a project or link";
  find.setAttribute("aria-label", "Find in the graph");
  const hud = document.createElement("div");
  hud.className = "graph-hud";
  hud.append(find);
  const detail = document.createElement("div");
  detail.className = "graph-detail";
  detail.hidden = true;
  stage.append(canvas, hud, detail);
  const foot = document.createElement("div");
  foot.className = "graph-foot";
  const hint = document.createElement("p");
  hint.className = "meta";
  hint.textContent = "Drag to move. Scroll to zoom. Double-click a project to open it.";
  const large = document.createElement("button");
  large.type = "button";
  large.className = "text";
  large.textContent = "Open large";
  large.addEventListener("click", openLargeGraph);
  foot.append(hint, large);
  viewRoot.append(stage, foot);
  ui.graph = mountGraph(canvas, model, {
    getQuery: () => find.value,
    onSelect(node) {
      fillGraphDetail(detail, node, openGraphNode);
    },
    onOpen: openGraphNode,
  });
  find.addEventListener("input", () => ui.graph?.redraw());
}

function openLargeGraph() {
  if (ui.live) {
    chrome.tabs.create({ url: chrome.runtime.getURL("graph.html") });
    return;
  }
  window.open("graph.html", "_blank");
}

function openGraphNode(node) {
  if (!node) return;
  if (node.kind === "link") {
    openSavedLink({ title: node.label, url: node.url }, node.projectId);
    return;
  }
  if (node.kind === "suggestion") {
    setStatus(node.intent || node.label);
    return;
  }
  const project = ui.state.projects.find((item) => item.id === node.id);
  if (project) openFiledProject(project);
}

function renderTimeline() {
  const weeks = ui.state.timeline || [];
  if (!weeks.some((week) => week.entries?.length)) {
    viewRoot.append(empty("Nothing filed yet."));
    return;
  }
  const list = document.createElement("ul");
  list.className = "tabs bare";
  for (const week of weeks) {
    if (!week.entries?.length) continue;
    const separator = document.createElement("li");
    separator.className = "week";
    separator.textContent = week.label;
    list.append(separator);
    for (const entry of week.entries) {
      list.append(renderLinkRow(entry, { openable: true }));
    }
  }
  viewRoot.append(list);
}

function renderGroupButton() {
  const actions = document.createElement("div");
  actions.className = "actions";
  const group = document.createElement("button");
  group.type = "button";
  group.className = "primary";
  group.textContent = "Group my tabs";
  group.addEventListener("click", () => groupLiveTabs(group));
  actions.append(group);
  return actions;
}

function renderActive() {
  viewRoot.append(renderGroupButton());

  const list = document.createElement("ul");
  list.className = "tabs bare";
  for (const tab of ui.state.active) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tab";
    appendFavicon(button, tab);
    const copy = document.createElement("span");
    copy.className = "tab-copy";
    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = tab.title;
    title.title = tab.title || "";
    copy.append(title);
    button.append(copy);
    if (tab.group) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = tab.group;
      button.append(badge);
    }
    button.addEventListener("click", () => {
      if (ui.live && Number.isInteger(tab.id)) {
        focusTab(tab.id);
        return;
      }
      setStatus("Sample tab. This row is not one of your open tabs.");
    });
    item.append(button);
    list.append(item);
  }
  viewRoot.append(list);
}

function renderOpenTab(tab) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tab";
  appendFavicon(button, tab);
  const label = document.createElement("span");
  label.className = "tab-title";
  label.textContent = tab.title || tab.url || "Untitled";
  label.title = tab.title || tab.url || "";
  button.append(label);
  button.addEventListener("click", () => {
    if (Number.isInteger(tab.id)) focusTab(tab.id);
  });
  item.append(button);
  return item;
}

function renderChromeGroup(group) {
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
  const total = group.tabs?.length || 0;
  count.textContent = total === 1 ? "1 tab" : `${total} tabs`;
  const list = document.createElement("ul");
  list.className = "tabs";
  for (const tab of group.tabs || []) list.append(renderOpenTab(tab));
  card.append(head, count, list);
  return card;
}

function sectionLabel(text) {
  const heading = document.createElement("h2");
  heading.className = "section-label";
  heading.textContent = text;
  return heading;
}

function empty(text) {
  const paragraph = document.createElement("p");
  paragraph.className = "empty";
  paragraph.textContent = text;
  return paragraph;
}

async function fileSuggestion(suggestion) {
  if (ui.busy) return;
  ui.busy = true;
  setStatus(`Filing “${suggestion.label}”…`);
  const response = await chrome.runtime.sendMessage({ type: "accept-suggestion", key: suggestion.key });
  ui.busy = false;
  if (!response?.ok) {
    failStatus(response, "Could not file that suggestion.");
    return;
  }
  const name = response.result.project?.name || suggestion.label;
  const where = response.result.created ? `Filed “${name}”.` : `Filed into ${name}.`;
  setStatus(response.result.warning ? `${where} ${response.result.warning}` : where);
  ui.movingLinkId = null;
  await loadLive();
}

async function fileRemove(link) {
  if (ui.busy) return;
  ui.busy = true;
  ui.movingLinkId = null;
  setStatus(`Removing ${link.title || "that tab"}…`);
  const response = await chrome.runtime.sendMessage({ type: "remove-link", linkId: link.id });
  ui.busy = false;
  if (!response?.ok) {
    failStatus(response, "Could not remove that tab.");
    render();
    return;
  }
  const title = response.result.title || link.title || "That tab";
  const project = response.result.project ? ` from ${response.result.project}` : "";
  setStatus(`Removed ${title}${project}.`);
  await loadLive();
}

async function fileMove(linkId, projectId, path) {
  if (ui.busy) return;
  ui.busy = true;
  setStatus(`Moving to ${path}…`);
  const response = await chrome.runtime.sendMessage({
    type: "move-link",
    linkId,
    projectId,
  });
  ui.busy = false;
  ui.movingLinkId = null;
  if (!response?.ok) {
    failStatus(response, "Could not move that link.");
    render();
    return;
  }
  const line = response.result.collapsed ? `That page was already in ${path}.` : `Moved to ${path}.`;
  setStatus(response.result.warning ? `${line} ${response.result.warning}` : line);
  await loadLive();
}

async function commitRename(project, name) {
  ui.renamingId = null;
  if (!ui.live) {
    const result = renameProject(ui.state, project.id, name);
    if (result.error) {
      setStatus(result.error);
      render();
      return;
    }
    ui.state = result.state;
    setStatus(`Renamed to ${name}.`);
    render();
    return;
  }
  setStatus(`Renaming ${project.name}…`);
  const response = await chrome.runtime.sendMessage({ type: "rename-project", projectId: project.id, name });
  if (!response?.ok) {
    failStatus(response, "Could not rename that project.");
    render();
    return;
  }
  const warning = response.result.warning ? ` ${response.result.warning}` : "";
  setStatus(`Renamed to ${response.result.name}.${warning}`);
  await loadLive();
}

async function removeFiledProject(project) {
  ui.confirmingRemoveId = null;
  if (!ui.live) {
    ui.state = removeProject(ui.state, project.id);
    setStatus(`Removed ${project.name}.`);
    render();
    return;
  }
  setStatus(`Removing ${project.name}…`);
  const response = await chrome.runtime.sendMessage({ type: "delete-project", projectId: project.id });
  if (!response?.ok) {
    failStatus(response, "Could not remove that project.");
    render();
    return;
  }
  setStatus(`Removed ${project.name}.`);
  await loadLive();
}

async function groupLiveTabs(button) {
  if (ui.busy) return;
  if (!ui.live) {
    setStatus("Open the side panel in Chrome to group the tabs.");
    return;
  }
  ui.busy = true;
  button.disabled = true;
  setStatus("Grouping tabs…");
  const response = await chrome.runtime.sendMessage({ type: "group-tabs" });
  ui.busy = false;
  button.disabled = false;
  if (!response?.ok) {
    failStatus(response, "Could not group tabs.");
    return;
  }
  const names = response.result?.projects || [];
  const made = response.result?.chromeGroups || names.length;
  const warning = response.result?.warning ? ` ${response.result.warning}` : "";
  if (made === 0) {
    setStatus(`No open tabs could be grouped.${warning}`);
  } else {
    setStatus(`Grouped ${names.join(", ")} in Chrome.${warning}`);
  }
  await loadLive();
}

async function openFiledProject(project) {
  if (!project.links.length) {
    setStatus(`${project.name} has no links to open.`);
    return;
  }
  if (!ui.live) {
    setStatus(`Opening ${project.name}.`);
    return;
  }
  setStatus(`Opening ${project.name}…`);
  const response = await chrome.runtime.sendMessage({ type: "open-project", projectId: project.id });
  if (!response?.ok) failStatus(response, "Could not open that project.");
  else setStatus(`Opened ${project.name}.`);
}

async function openSavedLink(link, projectId) {
  const project = ui.state.projects.find((item) => item.id === projectId);
  if (!ui.live) {
    setStatus(`Opening ${link.title}.`);
    return;
  }
  const response = await chrome.runtime.sendMessage({
    type: "open-link",
    url: link.url,
    projectName: project?.name || "",
  });
  if (!response?.ok) failStatus(response, "Could not open that link.");
}

async function focusTab(tabId) {
  const response = await chrome.runtime.sendMessage({ type: "focus-tab", tabId });
  if (!response?.ok) failStatus(response, "Could not open that tab.");
}

function appendFavicon(parent, item) {
  const src = faviconSrc(item?.url, item?.favIconUrl);
  if (!src) return;
  const icon = document.createElement("img");
  icon.alt = "";
  icon.src = src;
  icon.addEventListener("error", () => icon.remove());
  parent.append(icon);
}

function faviconSrc(url, favIconUrl) {
  if (favIconUrl) return favIconUrl;
  if (!url) return "";
  const id = globalThis.chrome?.runtime?.id;
  if (id) return `chrome-extension://${id}/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`;
  try {
    const host = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
  } catch {
    return "";
  }
}

