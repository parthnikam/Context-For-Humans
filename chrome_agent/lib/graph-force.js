import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from "../vendor/d3-force.esm.js";
import { searchUrlKey } from "./url.js";

const LINK_LABEL_ZOOM = 1.05;
const PROJECT_REVEAL = [0.45, 0.75];
const LINK_REVEAL = [1.05, 1.4];

function zoomReveal(kind, currentZoom) {
  if (kind === "category") return 1;
  const [from, to] = kind === "project" ? PROJECT_REVEAL : LINK_REVEAL;
  if (currentZoom <= from) return 0;
  if (currentZoom >= to) return 1;
  return (currentZoom - from) / (to - from);
}

function rgbaOf(color) {
  const value = String(color || "").trim();
  const hex = value.startsWith("#") ? value.slice(1) : "";
  if (hex.length === 6) {
    const num = Number.parseInt(hex, 16);
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
  }
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (match) {
    const parts = match[1].split(",").map((part) => Number.parseFloat(part));
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
  }
  return [0, 0, 0];
}

function colorFor(node) {
  if (node.kind === "category") return node.color;
  return lightenColor(node.color, node.kind === "project" ? 0.12 : 0.32);
}

function radiusFor(kind) {
  if (kind === "category") return 17;
  if (kind === "project") return 8;
  return 3.5;
}

function lightenColor(color, amount) {
  const value = String(color || "").trim();
  const hex = value.startsWith("#") ? value.slice(1) : "";
  if (hex.length !== 6) return value;
  const num = Number.parseInt(hex, 16);
  if (Number.isNaN(num)) return value;
  const mix = (channel) => Math.round(channel + (255 - channel) * amount);
  return `rgb(${mix((num >> 16) & 255)}, ${mix((num >> 8) & 255)}, ${mix(num & 255)})`;
}

function publish(node) {
  if (!node) return null;
  return {
    id: node.id,
    kind: node.kind,
    label: node.label,
    intent: node.intent || "",
    url: node.url || "",
    projectId: node.projectId || "",
    categoryId: node.categoryId || "",
    links: node.kind === "project"
      ? (node.links || []).map((link) => ({ title: link.title || "", url: link.url || "" }))
      : [],
  };
}

function clip(label, max) {
  const text = String(label || "");
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function themeColors() {
  const root = getComputedStyle(document.documentElement);
  return {
    ink: root.getPropertyValue("--ink").trim() || "#1d1a16",
    accent: root.getPropertyValue("--accent").trim() || "#243f34",
    bg: getComputedStyle(document.body).backgroundColor,
  };
}

export function mountGraph(container, model, options = {}) {
  const canvas = document.createElement("canvas");
  canvas.className = "graph-force-canvas";
  container.append(canvas);
  const ctx = canvas.getContext("2d");
  const theme = themeColors();

  const nodes = model.nodes.map((node) => ({ ...node, r: radiusFor(node.kind) }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const links = model.edges
    .map((edge) => ({ ...edge, source: byId.get(edge.source), target: byId.get(edge.target) }))
    .filter((edge) => edge.source && edge.target);

  const simulation = forceSimulation(nodes)
    .force("link", forceLink(links)
      .id((node) => node.id)
      .distance((edge) => (edge.kind === "parent" ? 95 : 48))
      .strength((edge) => (edge.kind === "parent" ? 0.6 : 0.2)))
    .force("charge", forceManyBody()
      .strength((node) => (node.kind === "category" ? -380 : node.kind === "project" ? -160 : -40)))
    .force("collide", forceCollide((node) => node.r + 5).iterations(2))
    .force("x", forceX(0).strength(0.02))
    .force("y", forceY(0).strength(0.02))
    .velocityDecay(0.34)
    .alphaDecay(0.018)
    .alphaTarget(0.03)
    .on("tick", draw);

  let viewWidth = 1;
  let viewHeight = 1;
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let hover = null;
  let selected = null;
  let drag = null;
  let moved = false;
  let last = null;
  let userMovedCamera = false;

  function screenToWorld(x, y) {
    return {
      x: (x - viewWidth / 2 - panX) / zoom,
      y: (y - viewHeight / 2 - panY) / zoom,
    };
  }

  function localPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function hit(wx, wy) {
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index];
      if (node !== hover && node !== selected && zoomReveal(node.kind, zoom) < 0.2) continue;
      const dx = node.x - wx;
      const dy = node.y - wy;
      const reach = node.r + 5;
      if (dx * dx + dy * dy <= reach * reach) return node;
    }
    return null;
  }

  function neighborhood(node) {
    const near = new Set();
    if (!node) return near;
    near.add(node.id);
    for (const link of links) {
      if (link.source === node || link.target === node) {
        near.add(link.source.id);
        near.add(link.target.id);
      }
    }
    return near;
  }

  function queryMatches() {
    const query = String(options.getQuery?.() || "").trim().toLowerCase();
    const semanticUrls = options.getSemanticMatches?.() || new Set();
    if (!query && !semanticUrls.size) return null;
    const matches = new Set();
    for (const node of nodes) {
      const semantic = node.url && semanticUrls.has(searchUrlKey(node.url));
      if (semantic || (query && `${node.label} ${node.intent || ""}`.toLowerCase().includes(query))) {
        matches.add(node.id);
      }
    }
    for (const link of links) {
      if (matches.has(link.source.id) || matches.has(link.target.id)) {
        matches.add(link.source.id);
        matches.add(link.target.id);
      }
    }
    return matches;
  }

  function fitCamera() {
    if (!nodes.length) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
      minX = Math.min(minX, node.x - node.r - 26);
      maxX = Math.max(maxX, node.x + node.r + 26);
      minY = Math.min(minY, node.y - node.r - 22);
      maxY = Math.max(maxY, node.y + node.r + 36);
    }
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    zoom = Math.max(0.2, Math.min(2.2, Math.min(viewWidth / spanX, viewHeight / spanY)));
    panX = -((minX + maxX) / 2) * zoom;
    panY = -((minY + maxY) / 2) * zoom;
  }

  function draw() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(viewWidth * dpr) || canvas.height !== Math.round(viewHeight * dpr)) {
      canvas.width = Math.round(viewWidth * dpr);
      canvas.height = Math.round(viewHeight * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewWidth, viewHeight);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, viewWidth, viewHeight);
    ctx.save();
    ctx.translate(viewWidth / 2 + panX, viewHeight / 2 + panY);
    ctx.scale(zoom, zoom);

    const active = hover || selected;
    const near = neighborhood(active);
    const matches = queryMatches();
    const dim = (id) => {
      if (matches && !matches.has(id)) return true;
      if (!matches && active && !near.has(id)) return true;
      return false;
    };
    const reveal = (node) => {
      if (node === hover || node === selected || near.has(node.id)) return 1;
      return zoomReveal(node.kind, zoom);
    };

    for (const link of links) {
      const hot = active && near.has(link.source.id) && near.has(link.target.id);
      const faded = dim(link.source.id) || dim(link.target.id);
      const vis = Math.min(reveal(link.source), reveal(link.target));
      if (vis <= 0.01) continue;
      ctx.globalAlpha = (faded ? 0.06 : hot ? 0.95 : 0.4) * vis;
      ctx.strokeStyle = hot ? link.source.color : theme.ink;
      ctx.lineWidth = hot ? 1.6 : 1;
      ctx.beginPath();
      ctx.moveTo(link.source.x, link.source.y);
      ctx.lineTo(link.target.x, link.target.y);
      ctx.stroke();
    }

    const query = String(options.getQuery?.() || "").trim().toLowerCase();
    const semanticUrls = options.getSemanticMatches?.() || new Set();
    for (const node of nodes) {
      const vis = reveal(node);
      if (vis <= 0.01) continue;
      const faded = dim(node.id);
      const fill = colorFor(node);
      ctx.globalAlpha = (faded ? 0.13 : 1) * vis;
      if (vis >= 0.999) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
        if (node === hover || node === selected) {
          ctx.lineWidth = 2;
          ctx.strokeStyle = theme.ink;
          ctx.stroke();
        }
        if (node.url && semanticUrls.has(searchUrlKey(node.url))) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, node.r + 3.5, 0, Math.PI * 2);
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = node.color;
          ctx.stroke();
        }
      } else {
        const [red, green, blue] = rgbaOf(fill);
        const radius = node.r * 1.6;
        const glow = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, radius);
        glow.addColorStop(0, `rgba(${red},${green},${blue},1)`);
        glow.addColorStop(0.55, `rgba(${red},${green},${blue},0.4)`);
        glow.addColorStop(1, `rgba(${red},${green},${blue},0)`);
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
      const named = node.kind !== "link"
        || zoom >= LINK_LABEL_ZOOM
        || node === hover
        || (active && near.has(node.id))
        || (query && node.label.toLowerCase().includes(query));
      if (!named || vis < 0.9) continue;
      ctx.save();
      ctx.translate(node.x, node.y + node.r + 4);
      ctx.scale(1 / zoom, 1 / zoom);
      ctx.globalAlpha = (faded ? 0.2 : 0.95) * vis;
      ctx.fillStyle = theme.ink;
      ctx.font = node.kind === "category" ? "700 13px Segoe UI, sans-serif" : "11px Segoe UI, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(clip(node.label, node.kind === "link" ? 22 : 26), 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  function reheat(amount) {
    simulation.alpha(Math.max(simulation.alpha(), amount));
    simulation.restart();
  }

  let glideToken = 0;

  function glideToNode(node) {
    const token = ++glideToken;
    const fromPanX = panX;
    const fromPanY = panY;
    const toPanX = viewWidth * 0.6 - viewWidth / 2 - node.x * zoom;
    const toPanY = viewHeight * 0.5 - viewHeight / 2 - node.y * zoom;
    const start = performance.now();
    const duration = 380;
    function frame(now) {
      if (token !== glideToken) return;
      const t = Math.min(1, (now - start) / duration);
      const eased = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
      panX = fromPanX + (toPanX - fromPanX) * eased;
      panY = fromPanY + (toPanY - fromPanY) * eased;
      draw();
      if (t < 1) window.requestAnimationFrame(frame);
    }
    window.requestAnimationFrame(frame);
  }

  function resize() {
    const rect = container.getBoundingClientRect();
    viewWidth = Math.max(1, rect.width || 1);
    viewHeight = Math.max(1, rect.height || 1);
    draw();
  }

  function onPointerDown(event) {
    if (event.button != null && event.button !== 0) return;
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // The pointer can end before capture.
    }
    const point = localPoint(event);
    const world = screenToWorld(point.x, point.y);
    const node = hit(world.x, world.y);
    last = point;
    moved = false;
    if (node) {
      drag = { type: "node", node, dx: world.x - node.x, dy: world.y - node.y };
      node.fx = node.x;
      node.fy = node.y;
      reheat(0.25);
    } else {
      drag = { type: "pan" };
    }
    canvas.style.cursor = "grabbing";
  }

  function onPointerMove(event) {
    const point = localPoint(event);
    if (!drag) {
      const world = screenToWorld(point.x, point.y);
      const next = hit(world.x, world.y);
      if (next !== hover) {
        hover = next;
        canvas.style.cursor = next ? "pointer" : "grab";
        draw();
      }
      return;
    }
    const dx = point.x - last.x;
    const dy = point.y - last.y;
    if (dx * dx + dy * dy > 9) moved = true;
    last = point;
    if (drag.type === "pan") {
      if (moved) {
        userMovedCamera = true;
        panX += dx;
        panY += dy;
        draw();
      }
      return;
    }
    const world = screenToWorld(point.x, point.y);
    drag.node.fx = world.x - drag.dx;
    drag.node.fy = world.y - drag.dy;
  }

  function onPointerUp() {
    const node = drag?.type === "node" ? drag.node : null;
    if (node) {
      node.fx = null;
      node.fy = null;
      if (!moved) {
        selected = node;
        options.onSelect?.(publish(node));
        if (node.kind === "link") {
          options.onOpen?.(publish(node));
        } else {
          glideToNode(node);
          reheat(0.2);
        }
      } else {
        reheat(0.35);
      }
    } else if (drag?.type === "pan" && !moved && selected) {
      selected = null;
      options.onSelect?.(null);
    }
    drag = null;
    canvas.style.cursor = hover ? "pointer" : "grab";
  }

  function onPointerLeave() {
    if (drag) return;
    if (!hover) return;
    hover = null;
    canvas.style.cursor = "grab";
    draw();
  }

  function onWheel(event) {
    event.preventDefault();
    userMovedCamera = true;
    const point = localPoint(event);
    const prev = zoom;
    const next = Math.min(3, Math.max(0.18, zoom * Math.exp(-event.deltaY * 0.0012)));
    const worldX = (point.x - viewWidth / 2 - panX) / prev;
    const worldY = (point.y - viewHeight / 2 - panY) / prev;
    zoom = next;
    panX = point.x - viewWidth / 2 - worldX * next;
    panY = point.y - viewHeight / 2 - worldY * next;
    draw();
  }

  function onDoubleClick(event) {
    const point = localPoint(event);
    const world = screenToWorld(point.x, point.y);
    const node = hit(world.x, world.y);
    if (!node) return;
    options.onOpen?.(publish(node));
  }

  function onKey(event) {
    if (event.key !== "Escape" || event.target?.closest?.("input, textarea")) return;
    if (!selected) return;
    selected = null;
    options.onSelect?.(null);
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("dblclick", onDoubleClick);
  window.addEventListener("keydown", onKey);
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();
  const fitTimer = window.setTimeout(() => {
    if (!userMovedCamera) fitCamera();
    draw();
  }, 650);

  return {
    destroy() {
      simulation.stop();
      window.clearTimeout(fitTimer);
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("dblclick", onDoubleClick);
      window.removeEventListener("keydown", onKey);
      canvas.remove();
    },
    redraw() {
      draw();
    },
  };
}
