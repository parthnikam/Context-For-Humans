export function appendGraphData(existingProjects, existingConversations, newProjects, newConversations) {
  const projects = (existingProjects || []).map((project) => ({
    ...project,
    links: [...(project.links || [])],
  }));
  const conversations = [...(existingConversations || [])];
  const knownUrls = new Set(conversations.map((conversation) => urlKey(conversation.url)).filter(Boolean));
  const projectByName = new Map(
    projects.map((project) => [String(project.name || "").trim().toLocaleLowerCase(), project]),
  );
  let nextProjectNumber = 1;
  const projectIds = new Set(projects.map((project) => project.id));
  const nextProjectId = () => {
    while (projectIds.has(`project-${nextProjectNumber}`)) nextProjectNumber += 1;
    const id = `project-${nextProjectNumber}`;
    projectIds.add(id);
    nextProjectNumber += 1;
    return id;
  };

  for (const conversation of newConversations || []) {
    const key = urlKey(conversation.url);
    if (!key || knownUrls.has(key)) continue;
    conversations.push(conversation);
    knownUrls.add(key);
  }

  for (const incoming of newProjects || []) {
    const freshLinks = (incoming.links || []).filter((link) => {
      const key = urlKey(link.url);
      if (!key || !knownUrls.has(key)) return false;
      const alreadyAssigned = projects.some((project) =>
        (project.links || []).some((existing) => urlKey(existing.url) === key)
      );
      if (alreadyAssigned) return false;
      return true;
    });
    if (!freshLinks.length) continue;

    const nameKey = String(incoming.name || "").trim().toLocaleLowerCase();
    const existing = projectByName.get(nameKey);
    if (existing) {
      existing.links.push(...freshLinks);
      continue;
    }

    const project = {
      ...incoming,
      id: !incoming.id || projectIds.has(incoming.id) ? nextProjectId() : incoming.id,
      links: freshLinks,
    };
    projectIds.add(project.id);
    projects.push(project);
    if (nameKey) projectByName.set(nameKey, project);
  }

  return { projects, conversations };
}

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
