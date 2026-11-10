import { mountGraph } from "./graph-force.js";
import { fillGraphDetail } from "./graph-detail.js";
import { graphModel, unassignedConversations } from "./graph-model.js";
import { providerLogo } from "./provider-logos.js";

const mountedGraphs = new WeakMap();
const categoryExpansion = new WeakMap();
const viewModes = new WeakMap();

const VIEW_ICONS = {
  list: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></svg>',
  graph: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M4.3 4.5 11.6 6M4.3 4.5 6 11.9M11.6 6 6 11.9"/><circle cx="4" cy="4" r="2" fill="currentColor" stroke="none"/><circle cx="12" cy="5.7" r="2" fill="currentColor" stroke="none"/><circle cx="5.8" cy="12.1" r="2" fill="currentColor" stroke="none"/></svg>',
};

export function renderGraph(host, projects, detailHost, onOpen, onEdit, graphOptions = {}) {
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
  find.placeholder = "Search projects or conversations by text";
  find.setAttribute("aria-label", "Search categories, projects, and conversation titles");
  toolbar.append(toggle, find);
  const results = document.createElement("div");
  results.className = "category-browser-list";
  const stage = document.createElement("div");
  stage.className = "graph-view-stage";
  host.append(toolbar, results, stage);
  detailHost.hidden = true;
  detailHost.replaceChildren();

  const openCategories = categoryExpansion.get(host) || new Set();
  categoryExpansion.set(host, openCategories);
  let mode = viewModes.get(host) === "graph" ? "graph" : "list";
  let graphHandle = null;

  const mountedModel = graphModel({ projects });

  function mountNodeGraph() {
    graphHandle?.destroy();
    graphHandle = mountGraph(stage, mountedModel, {
      getQuery: () => find.value.trim(),
      onSelect: (node) => {
        if (!node) {
          detailHost.hidden = true;
          detailHost.replaceChildren();
          return;
        }
        fillGraphDetail(detailHost, node, onOpen, projects);
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
    const unassigned = unassignedConversations(projects, graphOptions.conversations);
    for (const project of projects) {
      const id = String(project.categoryId || "uncategorized");
      const name = String(project.categoryName || (id === "uncategorized" ? "Needs category repair" : id));
      const entry = categories.get(id) || { id, name, projects: [] };
      entry.projects.push(project);
      categories.set(id, entry);
    }

    const ordered = [...categories.values()].sort((left, right) => left.name.localeCompare(right.name));
    const matchingUnassigned = unassigned.filter((conversation) => (
      !query
      || String(conversation.title || "").toLowerCase().includes(query)
    ));
    if (!ordered.length && !matchingUnassigned.length) {
      const empty = document.createElement("p");
      empty.className = "empty-graph";
      empty.textContent = unassigned.length
        ? "No unassigned conversations match that search."
        : "Import conversations to build your category list.";
      results.append(empty);
      return;
    }

    let visibleCategoryCount = 0;
    for (const category of ordered) {
      const matchingProjects = category.projects.filter((project) => {
        if (!query) return true;
        return category.name.toLowerCase().includes(query)
          || String(project.name || "").toLowerCase().includes(query)
          || String(project.intent || "").toLowerCase().includes(query)
          || (project.links || []).some((link) => String(link.title || "").toLowerCase().includes(query));
      });
      if (!matchingProjects.length && query) continue;

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
            || String(link.title || "").toLowerCase().includes(query);
        });
        const linkList = document.createElement("ul");
        linkList.className = "category-links";
        for (const link of links) {
          const row = document.createElement("li");
          row.className = "category-link-row";
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

    if (matchingUnassigned.length) {
      const section = document.createElement("details");
      section.className = "category-item unassigned-category";
      section.open = openCategories.has("unassigned-conversations")
        || Boolean(query && matchingUnassigned.length);
      section.addEventListener("toggle", () => {
        if (section.open) openCategories.add("unassigned-conversations");
        else openCategories.delete("unassigned-conversations");
      });

      const summary = document.createElement("summary");
      summary.className = "category-summary";
      const name = document.createElement("span");
      name.className = "category-name";
      name.textContent = "Unassigned conversations";
      const count = document.createElement("span");
      count.className = "category-count";
      count.textContent = `${matchingUnassigned.length} conversation(s)`;
      summary.append(name, count);
      section.append(summary);

      const linkList = document.createElement("ul");
      linkList.className = "category-links";
      for (const conversation of matchingUnassigned) {
        const row = document.createElement("li");
        row.className = "category-link-row";
        const anchor = document.createElement("a");
        anchor.className = "category-link";
        anchor.href = conversation.url;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        anchor.textContent = conversation.title || conversation.url;
        anchor.title = conversation.url;
        anchor.addEventListener("click", (event) => {
          event.preventDefault();
          onOpen?.({
            kind: "link",
            label: conversation.title || conversation.url,
            url: conversation.url,
          });
        });
        const logo = providerLogo(conversation.url);
        if (logo) row.append(logo);
        row.append(anchor);
        linkList.append(row);
      }
      section.append(linkList);
      results.append(section);
    }

    if (query && !visibleCategoryCount) {
      if (!matchingUnassigned.length) {
        const empty = document.createElement("p");
        empty.className = "empty-graph";
        empty.textContent = "No category or conversation matches that search.";
        results.append(empty);
      }
    }
  }

  drawCategories();
  setMode(mode);
  find.addEventListener("input", () => {
    drawCategories();
    graphHandle?.redraw();
  });
  mountedGraphs.set(host, {
    destroy() {
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
