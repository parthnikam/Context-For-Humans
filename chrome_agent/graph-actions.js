export async function openGraphNode(node, projects, setStatus) {
  const links = node.kind === "link"
    ? [{ title: node.label, url: node.url }]
    : projects.find((project) => project.id === node.id)?.links || [];
  if (!links.length) {
    setStatus(node.kind === "link" ? "This conversation has no URL." : "This project has no conversations to open.");
    return;
  }

  try {
    for (const [index, link] of links.entries()) {
      await chrome.tabs.create({ url: link.url, active: index === 0 });
    }
    setStatus(node.kind === "link"
      ? `Opened ${node.label}.`
      : `Opened ${links.length} conversation(s) from ${node.label}.`);
  } catch (error) {
    setStatus(`Could not open ${node.label}: ${error.message}`);
  }
}
