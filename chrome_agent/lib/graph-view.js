import { buildMountedModel, mountGraph } from "./graph-canvas.js";
import { fillGraphDetail } from "./graph-detail.js";
import { providerLogo } from "./provider-logos.js";
import { searchUrlKey } from "./url.js";

const mountedGraphs = new WeakMap();
const categoryExpansion = new WeakMap();
const viewModes = new WeakMap();
const graphExpansion = new WeakMap();

const VIEW_ICONS = {
  list: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></svg>',
  graph: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M4.3 4.5 11.6 6M4.3 4.5 6 11.9M11.6 6 6 11.9"/><circle cx="4" cy="4" r="2" fill="currentColor" stroke="none"/><circle cx="12" cy="5.7" r="2" fill="currentColor" stroke="none"/><circle cx="5.8" cy="12.1" r="2" fill="currentColor" stroke="none"/></svg>',
};

export function renderGraph(host, projects, detailHost, onStatus, onOpen, onEdit, graphOptions = {}) {
  const previous = mountedGraphs.get(host);
  previous?.destroy();
  host.replaceChildren();
  host.classList.add("category-browser");

  const toolbar = document.createElement("div");
  toolbar.className = "graph-toolbar";
  const toggle = document.createElement("div");
  toggle.className = "view-toggle";
  toggle.setAttribute("role", "group");
  toggle.setAttribute("aria-label", "Graph display mode");
  const listButton = viewToggleButton("list", "List view");
  const graphButton = viewToggleButton("graph", "Graph view");
  toggle.append(listButton, graphButton);
  const find = document.createElement("input");
  find.className = "graph-find";
  find.type = "search";
  find.placeholder = "Search projects or conversations by meaning";
  find.setAttribute("aria-label", "Search categories, projects, and conversation titles");
  toolbar.append(toggle, find);
  const results = document.createElement("div");
  results.className = "category-browser-list";
  const stage = document.createElement("div");
  stage.className = "graph-view-stage";
  const canvas = document.createElement("canvas");
  canvas.className = "graph-canvas";
  stage.append(canvas);
  host.append(toolbar, results, stage);
  detailHost.hidden = true;
  detailHost.replaceChildren();

  const openCategories = categoryExpansion.get(host) || new Set();
  categoryExpansion.set(host, openCategories);
  const expandedCategories = graphExpansion.get(host) || new Set();
  graphExpansion.set(host, expandedCategories);
  let semanticMatches = new Set();
  let searchTimer = 0;
  let searchSequence = 0;
  let mode = viewModes.get(host) === "graph" ? "graph" : "list";
  let graphHandle = null;

  const mountedModel = buildMountedModel(projects);

  function computeVisibleIds() {
    const ids = new Set();
    for (const node of mountedModel.nodes) {
      if (node.kind === "category") {
        ids.add(node.id);
      } else if (expandedCategories.has(String(node.categoryId || "uncategorized"))) {
        ids.add(node.id);
      }
    }
    return ids;
  }

  function mountNodeGraph() {
    graphHandle?.destroy();
    graphHandle = mountGraph(canvas, mountedModel, {
      initialVisible: computeVisibleIds(),
      getQuery: () => find.value.trim(),
      getSemanticMatches: () => semanticMatches,
      onSelect: (node) => {
        if (!node) {
          expandedCategories.clear();
          detailHost.hidden = true;
          detailHost.replaceChildren();
          graphHandle?.setVisible(computeVisibleIds());
          return;
        }
        fillGraphDetail(detailHost, node, onOpen, projects);
        if (node.kind !== "category" || !node.categoryId) return;
        if (expandedCategories.has(node.categoryId)) return;
        expandedCategories.add(node.categoryId);
        graphHandle?.setVisible(computeVisibleIds());
      },
      onOpen,
    });
  }

  function setMode(next) {
    mode = next;
    viewModes.set(host, next);
    host.classList.toggle("graph-mode", next === "graph");
    listButton.setAttribute("aria-pressed", String(next === "list"));
    graphButton.setAttribute("aria-pressed", String(next === "graph"));
    results.hidden = next !== "list";
    stage.hidden = next !== "graph";
    if (next === "graph") {
      mountNodeGraph();
    } else {
      graphHandle?.destroy();
      graphHandle = null;
      detailHost.hidden = true;
      detailHost.replaceChildren();
    }
  }

  listButton.addEventListener("click", () => setMode("list"));
  graphButton.addEventListener("click", () => setMode("graph"));

  function drawCategories(query = find.value.trim().toLowerCase()) {
    results.replaceChildren();
    const categories = new Map();
    for (const project of projects) {
      const id = String(project.categoryId || "uncategorized");
      const name = String(project.categoryName || (id === "uncategorized" ? "Needs category repair" : id));
      const entry = categories.get(id) || { id, name, projects: [] };
      entry.projects.push(project);
      categories.set(id, entry);
    }

    const ordered = [...categories.values()].sort((left, right) => left.name.localeCompare(right.name));
    if (!ordered.length) {
      const empty = document.createElement("p");
      empty.className = "empty-graph";
      empty.textContent = "Import conversations to build your category list.";
      results.append(empty);
      return;
    }

    let visibleCategoryCount = 0;
    for (const category of ordered) {
      const categoryHasSemanticMatch = category.projects.some((project) =>
        (project.links || []).some((link) => semanticMatches.has(searchUrlKey(link.url)))
      );
      const matchingProjects = category.projects.filter((project) => {
        if (!query) return true;
        return category.name.toLowerCase().includes(query)
          || String(project.name || "").toLowerCase().includes(query)
          || String(project.intent || "").toLowerCase().includes(query)
          || (project.links || []).some((link) => (
            String(link.title || "").toLowerCase().includes(query)
            || semanticMatches.has(searchUrlKey(link.url))
          ));
      });
      if (!matchingProjects.length && query && !categoryHasSemanticMatch) continue;

      visibleCategoryCount += 1;
      const section = document.createElement("details");
      section.className = "category-item";
      section.open = openCategories.has(category.id) || Boolean(query && matchingProjects.length);
      section.addEventListener("toggle", () => {
        if (section.open) openCategories.add(category.id);
        else openCategories.delete(category.id);
      });

      const summary = document.createElement("summary");
      summary.className = "category-summary";
      const categoryName = document.createElement("span");
      categoryName.className = "category-name";
      categoryName.textContent = category.name;
      const categoryCount = document.createElement("span");
      const conversationCount = category.projects.reduce(
        (count, project) => count + (project.links || []).length,
        0,
      );
      categoryCount.className = "category-count";
      categoryCount.textContent = `${category.projects.length} project(s) · ${conversationCount} link(s)`;
      summary.append(categoryName, categoryCount);
      section.append(summary);

      for (const project of matchingProjects) {
        const projectSection = document.createElement("section");
        projectSection.className = "category-project";
        const projectHeading = document.createElement("div");
        projectHeading.className = "category-project-heading";
        const projectTitle = document.createElement("strong");
        projectTitle.className = "category-project-title";
        projectTitle.textContent = project.name || "Untitled project";
        projectHeading.append(projectTitle);
        if (project.intent) {
          const intent = document.createElement("span");
          intent.className = "category-project-intent";
          intent.textContent = project.intent;
          projectHeading.append(intent);
        }
        projectSection.append(projectHeading);

        const links = (project.links || []).filter((link) => {
          if (!query) return true;
          return category.name.toLowerCase().includes(query)
            || String(project.name || "").toLowerCase().includes(query)
            || String(project.intent || "").toLowerCase().includes(query)
            || String(link.title || "").toLowerCase().includes(query)
            || semanticMatches.has(searchUrlKey(link.url));
        });
        const linkList = document.createElement("ul");
        linkList.className = "category-links";
        for (const link of links) {
          const row = document.createElement("li");
          row.className = "category-link-row";
          if (semanticMatches.has(searchUrlKey(link.url))) row.classList.add("semantic-match");
          const anchor = document.createElement("a");
          anchor.className = "category-link";
          anchor.href = link.url;
          anchor.target = "_blank";
          anchor.rel = "noopener noreferrer";
          anchor.textContent = link.title || link.url;
          anchor.title = link.url;
          anchor.addEventListener("click", (event) => {
            event.preventDefault();
            onOpen?.({
              kind: "link",
              label: link.title || link.url,
              url: link.url,
              projectId: project.id,
            });
          });
          const logo = providerLogo(link.url);
          if (logo) row.append(logo);
          row.append(anchor);

          const targets = category.projects.filter((target) => target.id !== project.id);
          if (targets.length) {
            const moveSelect = document.createElement("select");
            moveSelect.className = "category-link-move";
            moveSelect.setAttribute("aria-label", `Move ${link.title || link.url} to another project in ${category.name}`);
            moveSelect.append(new Option("Move...", ""));
            for (const target of targets) moveSelect.append(new Option(target.name, target.id));
            moveSelect.addEventListener("change", () => {
              if (!moveSelect.value) return;
              onEdit?.({
                type: "move",
                projectId: project.id,
                targetProjectId: moveSelect.value,
                url: link.url,
              });
            });
            row.append(moveSelect);
          }
          linkList.append(row);
        }
        projectSection.append(linkList);
        section.append(projectSection);
      }
      results.append(section);
    }

    if (query && !visibleCategoryCount) {
      const empty = document.createElement("p");
      empty.className = "empty-graph";
      empty.textContent = "No category or conversation matches that search.";
      results.append(empty);
    }
  }

  drawCategories();
  setMode(mode);
  find.addEventListener("input", () => {
    semanticMatches = new Set();
    drawCategories();
    graphHandle?.redraw();
    window.clearTimeout(searchTimer);
    const sequence = ++searchSequence;
    const query = find.value.trim();
    if (query.length < 2 || typeof graphOptions.search !== "function") {
      return;
    }
    searchTimer = window.setTimeout(async () => {
      try {
        const result = await graphOptions.search(query);
        if (sequence !== searchSequence) return;
        semanticMatches = new Set((Array.isArray(result.matches) ? result.matches : [])
          .map((item) => searchUrlKey(item.url))
          .filter(Boolean));
        drawCategories();
        graphHandle?.redraw();
        onStatus?.(semanticMatches.size
          ? `Found ${semanticMatches.size} semantically similar conversation(s).`
          : "No semantic matches found in the saved conversations.");
      } catch (error) {
        if (sequence !== searchSequence) return;
        drawCategories();
        graphHandle?.redraw();
        onStatus?.(`Similarity search unavailable: ${error.message}`);
      }
    }, 300);
  });
  mountedGraphs.set(host, {
    destroy() {
      window.clearTimeout(searchTimer);
      searchSequence += 1;
      graphHandle?.destroy();
      graphHandle = null;
    },
  });
}

function viewToggleButton(mode, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `view-toggle-button view-${mode}`;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", "false");
  button.title = label;
  button.innerHTML = VIEW_ICONS[mode];
  return button;
}
