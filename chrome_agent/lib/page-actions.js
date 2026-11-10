export function runPageAction(action) {
  function getLabel(element) {
    return (element.getAttribute("aria-label")
      || element.getAttribute("title")
      || element.innerText
      || element.textContent
      || "").trim().replace(/\s+/g, " ");
  }

  function isVisible(element, area) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const areaBounds = area === document.scrollingElement
      ? { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
      : area.getBoundingClientRect();
    const viewport = {
      left: Math.max(0, areaBounds.left),
      top: Math.max(0, areaBounds.top),
      right: Math.min(innerWidth, areaBounds.right),
      bottom: Math.min(innerHeight, areaBounds.bottom),
    };
    return style.display !== "none"
      && style.visibility !== "hidden"
      && Number(style.opacity) !== 0
      && rect.width > 0
      && rect.height > 0
      && rect.bottom > viewport.top
      && rect.top < viewport.bottom
      && rect.right > viewport.left
      && rect.left < viewport.right;
  }

  function selectorFor(element) {
    if (element === document.scrollingElement) return "document";
    if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) {
      return `#${CSS.escape(element.id)}`;
    }
    const parts = [];
    let node = element;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
      const tag = node.tagName.toLowerCase();
      let index = 1;
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.tagName === node.tagName) index += 1;
      }
      parts.unshift(`${tag}:nth-of-type(${index})`);
      node = node.parentElement;
    }
    return `html > ${parts.join(" > ")}`;
  }

  function resolveArea(selector) {
    if (selector === "document") return document.scrollingElement;
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  }

  function clearHighlight() {
    const previous = globalThis.__conversationExporterHighlight;
    if (!previous) return;
    window.removeEventListener("scroll", previous.update, true);
    window.removeEventListener("resize", previous.update);
    previous.overlay.remove();
    delete globalThis.__conversationExporterHighlight;
  }

  function highlightArea(area, label) {
    clearHighlight();
    const overlay = document.createElement("div");
    overlay.dataset.conversationExporterHighlight = "true";
    const caption = document.createElement("span");
    caption.textContent = `Selected: ${label}`;
    Object.assign(overlay.style, {
      position: "fixed",
      zIndex: "2147483647",
      pointerEvents: "none",
      boxSizing: "border-box",
      border: "3px solid #e13c3c",
      background: "rgba(225, 60, 60, 0.08)",
      borderRadius: "4px",
    });
    Object.assign(caption.style, {
      position: "absolute",
      left: "0",
      top: "0",
      maxWidth: "100%",
      padding: "3px 7px",
      color: "#fff",
      background: "#b42323",
      font: "600 12px/1.3 sans-serif",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    });
    overlay.append(caption);

    const update = () => {
      if (!area.isConnected && area !== document.scrollingElement) {
        clearHighlight();
        return;
      }
      const rect = area === document.scrollingElement
        ? { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
        : area.getBoundingClientRect();
      const left = Math.max(0, rect.left);
      const top = Math.max(0, rect.top);
      const right = Math.min(innerWidth, rect.right);
      const bottom = Math.min(innerHeight, rect.bottom);
      Object.assign(overlay.style, {
        left: `${left}px`,
        top: `${top}px`,
        width: `${Math.max(0, right - left)}px`,
        height: `${Math.max(0, bottom - top)}px`,
        display: right > left && bottom > top ? "block" : "none",
      });
    };

    document.documentElement.append(overlay);
    globalThis.__conversationExporterHighlight = { overlay, update };
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    update();
  }

  function collectLinks(area) {
    return [...area.querySelectorAll("a[href]")]
      .filter((link) => isVisible(link, area))
      .slice(0, 2000)
      .map((link) => {
        const title = getLabel(link) || link.href;
        return { title: title.slice(0, 500), url: link.href };
      })
      .filter((link) => {
        try {
          const protocol = new URL(link.url).protocol;
          return protocol === "http:" || protocol === "https:";
        } catch {
          return false;
        }
      });
  }

  if (action.type === "detect") {
    const candidates = [];
    const root = document.scrollingElement;
    if (root && root.scrollHeight > innerHeight + 40) candidates.push(root);
    for (const element of document.querySelectorAll("body *")) {
      if (element === root || element.hasAttribute("data-conversation-exporter-highlight")) continue;
      const style = getComputedStyle(element);
      if (!["auto", "scroll", "overlay"].includes(style.overflowY)) continue;
      if (element.scrollHeight <= element.clientHeight + 40 || element.clientHeight < 80) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 50 || rect.bottom <= 0 || rect.top >= innerHeight) continue;
      candidates.push(element);
    }

    const areas = candidates.map((element, index) => {
      const links = collectLinks(element);
      const rect = element === root
        ? { width: innerWidth, height: innerHeight }
        : element.getBoundingClientRect();
      const readableName = element === root
        ? "Full page"
        : element.getAttribute("aria-label")
          || element.getAttribute("title")
          || element.id
          || element.className?.toString().trim().split(/\s+/).slice(0, 2).join(".")
          || `Scrollable area ${index + 1}`;
      return {
        selector: selectorFor(element),
        label: String(readableName).slice(0, 100),
        visibleLinks: links.length,
        samples: links.slice(0, 3).map((link) => link.title.slice(0, 60)),
        size: `${Math.round(rect.width)} × ${Math.round(rect.height)}`,
      };
    }).sort((a, b) => b.visibleLinks - a.visibleLinks);
    return { ok: true, areas: areas.slice(0, 30) };
  }

  if (action.type === "clear-highlight") {
    clearHighlight();
    return { ok: true };
  }

  const area = resolveArea(action.selector);
  if (!area) return { ok: false, error: "The selected scroll area is no longer available. Detect areas again." };
  if (action.type === "highlight") {
    highlightArea(area, action.label);
    return { ok: true };
  }
  if (action.type === "begin") {
    const originalTop = area.scrollTop;
    area.scrollTop = 0;
    return { ok: true, originalTop };
  }
  if (action.type === "restore") {
    area.scrollTop = action.scrollTop;
    return { ok: true };
  }
  if (action.type === "nudge-up") {
    area.scrollTop = Math.max(0, area.scrollTop - Math.min(48, area.clientHeight * 0.1));
    return { ok: true };
  }
  if (action.type === "collect") {
    const top = area.scrollTop;
    return {
      ok: true,
      links: collectLinks(area),
      height: area.scrollHeight,
      atBottom: top >= area.scrollHeight - area.clientHeight - 2,
    };
  }
  if (action.type === "scroll-step") {
    const beforeTop = area.scrollTop;
    const links = collectLinks(area);
    const maximumTop = Math.max(0, area.scrollHeight - area.clientHeight);
    area.scrollTop = Math.min(maximumTop, beforeTop + Math.max(100, area.clientHeight * 0.75));
    const afterTop = area.scrollTop;
    return {
      ok: true,
      links,
      beforeTop,
      afterTop,
      height: area.scrollHeight,
      atBottom: afterTop >= area.scrollHeight - area.clientHeight - 2,
    };
  }
  return { ok: false, error: "Unknown page action." };
}
