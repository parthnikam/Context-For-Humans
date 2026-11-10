export function renameProject(projects, projectId, name) {
  const nextName = String(name || "").trim();
  if (!nextName) throw new Error("Project name cannot be empty.");
  if (!projects.some((project) => project.id === projectId)) {
    throw new Error("The project no longer exists.");
  }
  return projects.map((project) =>
    project.id === projectId ? { ...project, name: nextName } : project
  );
}

export function moveConversation(projects, sourceProjectId, targetProjectId, url) {
  if (sourceProjectId === targetProjectId) return projects;
  const source = projects.find((project) => project.id === sourceProjectId);
  const target = projects.find((project) => project.id === targetProjectId);
  if (!source || !target) throw new Error("Select an existing source and destination project.");

  const linkIndex = source.links.findIndex((link) => link.url === url);
  if (linkIndex < 0) throw new Error("The conversation no longer belongs to the source project.");
  const [link] = source.links.slice(linkIndex, linkIndex + 1);
  const sourceLinks = source.links.filter((_, index) => index !== linkIndex);
  const targetHasLink = target.links.some((item) => item.url === link.url);

  return projects.map((project) => {
    if (project.id === sourceProjectId) return { ...project, links: sourceLinks };
    if (project.id === targetProjectId && !targetHasLink) {
      return { ...project, links: [...project.links, link] };
    }
    return project;
  });
}
