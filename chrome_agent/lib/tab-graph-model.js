import { searchUrlKey as pageKey } from "./url.js";

const PALETTE = ["#e84393", "#0984e3", "#6c5ce7", "#00b894", "#f39c12", "#e17055", "#00cec9", "#a29bfe", "#fd79a8", "#2ecc71", "#f1c40f", "#34ace0"];

export function tabGraphModel({ projects, suggestions }) {
  const nodes = [];
  const edges = [];
  const byId = new Map();
  const linkByPage = new Map();
  const listed = (projects || []).filter((project) => project?.id);

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

  listed.forEach((project, index) => {
    addNode({
      id: project.id,
      kind: "project",
      label: project.name || "Untitled",
      intent: project.intent || "",
      projectId: project.id,
      url: "",
      color: PALETTE[index % PALETTE.length],
      links: project.links || [],
    });
  });

  for (const project of listed) {
    const color = byId.get(project.id)?.color;
    const seen = new Set();
    for (const link of project.links || []) {
      const key = pageKey(link.url);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      let node = linkByPage.get(key);
      if (!node) {
        node = addNode({
          id: `page:${key}`,
          kind: "link",
          label: link.title || key,
          url: link.url,
          projectId: project.id,
          color,
        });
        linkByPage.set(key, node);
      }
      addEdge(project.id, node.id, "link");
    }
  }

  for (const suggestion of suggestions || []) {
    if (!suggestion?.id) continue;
    addNode({
      id: suggestion.id,
      kind: "suggestion",
      label: suggestion.label || "Suggestion",
      intent: suggestion.one_liner || "",
      projectId: "",
      url: "",
      color: "#8a8175",
    });
    for (const tab of suggestion.tabs || []) {
      const key = pageKey(tab.url);
      if (!key) continue;
      let node = linkByPage.get(key);
      if (!node) {
        node = addNode({
          id: `page:${key}`,
          kind: "link",
          label: tab.title || key,
          url: tab.url,
          projectId: suggestion.id,
          color: "#8a8175",
        });
        linkByPage.set(key, node);
      }
      addEdge(suggestion.id, node.id, "link");
    }
  }

  return { nodes, edges };
}