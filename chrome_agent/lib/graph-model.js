const PALETTE = ["#2f6f5e", "#3c6e91", "#8a5a2a", "#6e4c86", "#8d4548", "#3e6b38", "#2c6a72", "#7a5730"];

function pageKey(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return value;
  }
}

export function graphModel(state) {
  const nodes = [];
  const edges = [];
  const byId = new Map();
  const projects = (state?.projects || []).filter((project) => project?.id);

  function addNode(node) {
    const existing = byId.get(node.id);
    if (existing) return existing;
    byId.set(node.id, node);
    nodes.push(node);
    return node;
  }

  function addEdge(source, target, kind) {
    if (!source || !target || source === target || !byId.has(source) || !byId.has(target)) return;
    const id = `${kind}:${source}->${target}`;
    if (edges.some((edge) => edge.id === id)) return;
    edges.push({ id, source, target, kind });
  }

  projects.forEach((project, index) => {
    const categoryId = String(project.categoryId || "uncategorized");
    const categoryName = String(project.categoryName || "Uncategorized");
    const categoryNode = addNode({
      id: `category:${categoryId}`,
      kind: "category",
      label: categoryName,
      categoryId,
      color: PALETTE[index % PALETTE.length],
    });
    addNode({
      id: project.id,
      kind: "project",
      label: project.name || "Untitled",
      intent: project.intent || "",
      projectId: project.id,
      categoryId,
      categoryName,
      color: categoryNode.color,
      links: project.links || [],
    });
    addEdge(`category:${categoryId}`, project.id, "parent");
  });

  for (const project of projects) {
    const color = byId.get(project.id)?.color;
    const seen = new Set();
    for (const link of project.links || []) {
      const key = pageKey(link?.url);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const node = addNode({
        id: `page:${JSON.stringify([project.id, key])}`,
        kind: "link",
        label: link.title || key,
        url: link.url,
        projectId: project.id,
        color,
      });
      addEdge(project.id, node.id, "link");
    }
  }

  return { nodes, edges };
}
