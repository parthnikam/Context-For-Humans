import { providerLogo } from "./provider-logos.js";

export function fillGraphDetail(host, node, onOpen, projects = []) {
  host.replaceChildren();
  if (!node) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  const heading = document.createElement("div");
  heading.className = "graph-detail-heading";
  const title = document.createElement("p");
  title.className = "graph-detail-title";
  title.textContent = node.label;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "graph-detail-close";
  close.setAttribute("aria-label", "Close project details");
  close.textContent = "×";
  close.addEventListener("click", () => {
    host.hidden = true;
    host.replaceChildren();
  });
  heading.append(title, close);
  host.append(heading);
  if (node.kind === "category") {
    const categoryProjects = projects.filter(
      (project) => (project.categoryId || "uncategorized") === node.categoryId,
    );
    const conversations = categoryProjects.reduce(
      (count, project) => count + (project.links || []).length,
      0,
    );
    const summary = document.createElement("p");
    summary.className = "one-liner";
    summary.textContent = `${categoryProjects.length} project(s) · ${conversations} conversation(s)`;
    host.append(summary);
    for (const project of categoryProjects) {
      const projectBlock = document.createElement("div");
      projectBlock.className = "graph-detail-project";
      const projectTitle = document.createElement("p");
      projectTitle.className = "graph-detail-project-title";
      projectTitle.textContent = `${project.name || "Untitled project"} (${(project.links || []).length})`;
      projectBlock.append(projectTitle);
      for (const link of project.links || []) {
        const row = document.createElement("div");
        row.className = "graph-detail-link-row";
        const logo = providerLogo(link.url);
        if (logo) row.append(logo);
        const item = document.createElement("a");
        item.className = "graph-detail-link";
        item.href = link.url;
        item.target = "_blank";
        item.rel = "noopener noreferrer";
        item.textContent = link.title || link.url;
        item.title = link.url;
        item.addEventListener("click", (event) => {
          event.preventDefault();
          onOpen({
            kind: "link",
            label: link.title || link.url,
            url: link.url,
            projectId: project.id,
          });
        });
        row.append(item);
        projectBlock.append(row);
      }
      host.append(projectBlock);
    }
    return;
  }
  if (node.kind === "suggestion") {
    const line = document.createElement("p");
    line.className = "one-liner";
    line.textContent = node.intent || "Still a suggestion. Accept it under Projects.";
    host.append(line);
    return;
  }
  if (node.intent) {
    const line = document.createElement("p");
    line.className = "one-liner";
    line.textContent = node.intent;
    host.append(line);
  }
  if (node.kind === "project") {
    const links = node.links || [];
    const linksHeading = document.createElement("p");
    linksHeading.className = "graph-detail-section-title";
    linksHeading.textContent = `Conversations (${links.length})`;
    const list = document.createElement("div");
    list.className = "graph-detail-links";
    for (const link of links) {
      const row = document.createElement("div");
      row.className = "graph-detail-link-row";
      const item = document.createElement("a");
      item.className = "graph-detail-link";
      item.href = link.url;
      item.target = "_blank";
      item.rel = "noopener noreferrer";
      item.textContent = link.title || link.url;
      item.title = link.url;
      item.addEventListener("click", (event) => {
        event.preventDefault();
        onOpen({
          kind: "link",
          label: link.title || link.url,
          url: link.url,
          projectId: node.projectId,
        });
      });
      const logo = providerLogo(link.url);
      if (logo) row.append(logo);
      row.append(item);
      list.append(row);
    }
    host.append(linksHeading, list);
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "text";
  button.textContent = node.kind === "link" ? "Open link" : "Open project";
  button.addEventListener("click", () => onOpen(node));
  host.append(button);
}
