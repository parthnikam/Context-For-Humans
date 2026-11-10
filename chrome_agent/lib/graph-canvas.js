import { graphModel } from "./graph-model.js";
import { searchUrlKey } from "./url.js";

const positions = new Map();
const LAYOUT = 4;
const SPAWN_FADE_STEP = 1 / 15;
const LINK_LEASH = 100;
const PROJECT_LEASH = 130;

function radius(node) {
  if (node.kind === "category") return 15;
  if (node.kind === "link") return 3;
  if (node.kind === "child") return 7;
  if (node.kind === "suggestion") return 7;
  return 6;
}

const LIGHT_NODE_KINDS = new Set(["project", "link"]);

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

export function mountGraph(canvas, model, options = {}) {
  const nodes = (model?.nodes || []).map((node) => ({
    ...node,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    r: radius(node),
    fixed: false,
    state: "on",
    fade: 1,
  }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = (model?.edges || [])
    .map((edge) => ({ ...edge, source: byId.get(edge.source), target: byId.get(edge.target) }))
    .filter((edge) => edge.source && edge.target);

  const anchorByNodeId = new Map();
  const categoryByNodeId = new Map();
  for (const node of nodes) {
    if (node.kind === "category") {
      anchorByNodeId.set(node.id, node);
      categoryByNodeId.set(node.id, node);
    }
  }
  for (const edge of edges) {
    if (edge.kind === "parent" && edge.target.kind === "project") {
      anchorByNodeId.set(edge.target.id, edge.source);
      categoryByNodeId.set(edge.target.id, edge.source);
    }
  }
  for (const edge of edges) {
    if (edge.kind !== "link") continue;
    anchorByNodeId.set(edge.target.id, edge.source);
    const hubCategory = categoryByNodeId.get(edge.source.id);
    if (hubCategory) categoryByNodeId.set(edge.target.id, hubCategory);
  }

  const linkSlots = new Map();
  const linksByProject = new Map();
  for (const edge of edges) {
    if (edge.kind !== "link" || edge.target.kind !== "link") continue;
    const links = linksByProject.get(edge.source.id) || [];
    links.push(edge.target);
    linksByProject.set(edge.source.id, links);
  }
  for (const [hubId, links] of linksByProject) {
    const hub = byId.get(hubId);
    if (!hub) continue;
    const orbitRadius = Math.max(48, links.length * 8);
    links.forEach((node, index) => {
      linkSlots.set(node.id, {
        hub,
        angle: (index / links.length) * Math.PI * 2 - Math.PI / 2,
        radius: orbitRadius,
      });
    });
  }
  if (positions.get("__v")?.x !== LAYOUT) {
    positions.clear();
    positions.set("__v", { x: LAYOUT, y: 0 });
  }
  const remembered = nodes.some((node) => positions.has(node.id));
  if (!remembered) placeFresh(nodes, edges);
  else {
    for (const node of nodes) {
      const saved = positions.get(node.id);
      if (!saved) continue;
      node.x = saved.x;
      node.y = saved.y;
    }
    placeMissing(nodes, edges);
  }

  let activeNodes = [];
  let activeEdges = [];
  let dirtyActive = false;
  refreshActive();
  if (options.initialVisible instanceof Set) {
    for (const node of nodes) {
      if (options.initialVisible.has(node.id)) {
        node.state = "on";
        node.fade = 1;
      } else {
        node.state = "off";
        node.fade = 0;
      }
    }
    refreshActive();
  }

  const ctx = canvas.getContext("2d");
  let viewWidth = 1;
  let viewHeight = 1;
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let alpha = remembered ? 0.35 : 1;
  let hover = null;
  let selected = null;
  let drag = null;
  let moved = false;
  let last = null;
  let userMoved = false;
  let fitted = false;
  let framed = false;
  let frame = 0;
  let running = true;
  let lastTime = 0;
  let camera = null;
  let stepping = false;

  function styles() {
    const root = getComputedStyle(document.documentElement);
    const stage = getComputedStyle(canvas.parentElement || document.body);
    return {
      bg: stage.backgroundColor,
      ink: getComputedStyle(document.body).color,
      line: root.getPropertyValue("--line").trim() || "#ddd6ca",
      muted: root.getPropertyValue("--muted").trim() || "#625c53",
      accent: root.getPropertyValue("--accent").trim() || "#243f34",
      card: root.getPropertyValue("--card").trim() || "#fffdf8",
    };
  }

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

  function refreshActive() {
    activeNodes = nodes.filter((node) => node.state !== "off");
    activeEdges = edges.filter((edge) => edge.source.state !== "off" && edge.target.state !== "off");
  }

  function fadeOf(node) {
    if (node.state === "in" || node.state === "out") {
      return Math.max(0, Math.min(1, node.fade));
    }
    return node.state === "off" ? 0 : 1;
  }

  function transitionsActive() {
    return activeNodes.some((node) => node.state === "in" || node.state === "out");
  }

  function setVisible(nextIds) {
    const next = nextIds instanceof Set ? nextIds : new Set(nextIds);
    for (const node of nodes) {
      const shouldShow = next.has(node.id);
      if (shouldShow && (node.state === "off" || node.state === "out")) {
        node.state = "in";
        const anchor = anchorByNodeId.get(node.id);
        if (anchor) {
          const angle = Math.random() * Math.PI * 2;
          const spread = node.kind === "link" ? 14 : 22;
          node.x = anchor.x + Math.cos(angle) * spread;
          node.y = anchor.y + Math.sin(angle) * spread;
          node.vx = 0;
          node.vy = 0;
          positions.set(node.id, { x: node.x, y: node.y });
        }
      } else if (!shouldShow && (node.state === "on" || node.state === "in")) {
        node.state = "out";
      }
    }
    refreshActive();
    wake(0.6);
  }

  function hit(wx, wy) {
    for (let index = activeNodes.length - 1; index >= 0; index -= 1) {
      const node = activeNodes[index];
      const dx = node.x - wx;
      const dy = node.y - wy;
      const reach = node.r + 4;
      if (dx * dx + dy * dy <= reach * reach) return node;
    }
    return null;
  }

  function queryMatches() {
    const query = String(options.getQuery?.() || "")
      .trim()
      .toLowerCase();
    const semanticUrls = options.getSemanticMatches?.() || new Set();
    if (!query && !semanticUrls.size) return null;
    const lexicalMatches = new Set(activeNodes
      .filter((node) => query && `${node.label} ${node.intent || ""}`.toLowerCase().includes(query))
      .map((node) => node.id));
    const semanticNodeIds = new Set(activeNodes
      .filter((node) => node.url && semanticUrls.has(searchUrlKey(node.url)))
      .map((node) => node.id));
    const matches = new Set([...lexicalMatches, ...semanticNodeIds]);
    for (const edge of activeEdges) {
      if (semanticNodeIds.has(edge.source.id) || semanticNodeIds.has(edge.target.id)) {
        matches.add(edge.source.id);
        matches.add(edge.target.id);
      }
    }
    for (const edge of activeEdges) {
      if (lexicalMatches.has(edge.source.id) || lexicalMatches.has(edge.target.id)) {
        matches.add(edge.source.id);
        matches.add(edge.target.id);
      }
    }
    return matches;
  }

  function neighborhood(node) {
    const near = new Set();
    if (!node) return near;
    near.add(node.id);
    for (const edge of activeEdges) {
      if (edge.source === node || edge.target === node) {
        near.add(edge.source.id);
        near.add(edge.target.id);
      }
    }
    return near;
  }

  function cameraFor(list) {
    if (!list.length) return { zoom, panX, panY };
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const node of list) {
      minX = Math.min(minX, node.x - node.r - 18);
      maxX = Math.max(maxX, node.x + node.r + 18);
      minY = Math.min(minY, node.y - node.r - 12);
      maxY = Math.max(maxY, node.y + node.r + 26);
    }
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const marginX = Math.min(36, viewWidth * 0.08);
    const marginY = Math.min(32, viewHeight * 0.08);
    const next = Math.min(
      1.85,
      Math.max(0.45, Math.min((viewWidth - marginX * 2) / spanX, (viewHeight - marginY * 2) / spanY)),
    );
    return {
      zoom: next,
      panX: -((minX + maxX) / 2) * next,
      panY: -((minY + maxY) / 2) * next,
    };
  }

  function animateCamera(target) {
    const ratio = Math.abs(Math.log((target.zoom || 1) / (zoom || 1)));
    camera = {
      fromZoom: zoom,
      fromPanX: panX,
      fromPanY: panY,
      toZoom: target.zoom,
      toPanX: target.panX,
      toPanY: target.panY,
      start: performance.now(),
      duration: Math.min(640, 320 + ratio * 180),
    };
    if (!stepping && !frame && running) frame = requestAnimationFrame(step);
  }

  function applyCamera(now) {
    if (!camera) return;
    const t = Math.min(1, (now - camera.start) / camera.duration);
    const eased = t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
    zoom = camera.fromZoom + (camera.toZoom - camera.fromZoom) * eased;
    panX = camera.fromPanX + (camera.toPanX - camera.fromPanX) * eased;
    panY = camera.fromPanY + (camera.toPanY - camera.fromPanY) * eased;
    if (t >= 1) camera = null;
  }

  function focusNode(node) {
    const ids = neighborhood(node);
    const list = activeNodes.filter((item) => ids.has(item.id));
    animateCamera(cameraFor(list.length ? list : [node]));
  }

  function showAll() {
    animateCamera(cameraFor(activeNodes));
  }

  function draw() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(viewWidth * dpr) || canvas.height !== Math.round(viewHeight * dpr)) {
      canvas.width = Math.round(viewWidth * dpr);
      canvas.height = Math.round(viewHeight * dpr);
    }
    const paint = styles();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewWidth, viewHeight);
    ctx.fillStyle = paint.bg;
    ctx.fillRect(0, 0, viewWidth, viewHeight);
    ctx.save();
    ctx.translate(viewWidth / 2 + panX, viewHeight / 2 + panY);
    ctx.scale(zoom, zoom);

    const active = hover || selected;
    const near = neighborhood(active);
    const matches = queryMatches();
    const faded = (id) => {
      if (matches && !matches.has(id)) return true;
      if (!matches && active && !near.has(id)) return true;
      return false;
    };

    for (const edge of activeEdges) {
      const dim = faded(edge.source.id) || faded(edge.target.id);
      const hot = active && near.has(edge.source.id) && near.has(edge.target.id);
      const edgeFade = Math.min(fadeOf(edge.source), fadeOf(edge.target));
      ctx.globalAlpha = (dim ? 0.07 : hot ? 1 : 0.72) * edgeFade;
      ctx.strokeStyle = hot ? paint.accent : paint.muted;
      ctx.lineWidth = hot ? 1.2 : 0.8;
      ctx.beginPath();
      ctx.moveTo(edge.source.x, edge.source.y);
      ctx.lineTo(edge.target.x, edge.target.y);
      ctx.stroke();
    }

    const query = String(options.getQuery?.() || "").trim().toLowerCase();
    const semanticUrls = options.getSemanticMatches?.() || new Set();
    for (const node of activeNodes) {
      const dim = faded(node.id);
      const nodeFade = fadeOf(node);
      ctx.globalAlpha = (dim ? 0.12 : 1) * nodeFade;
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2);
      if (node.kind === "suggestion") {
        ctx.fillStyle = paint.card;
        ctx.fill();
        ctx.lineWidth = 1.4;
        ctx.setLineDash([3, 2]);
        ctx.strokeStyle = paint.muted;
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = LIGHT_NODE_KINDS.has(node.kind)
          ? lightenColor(node.color, 0.35)
          : node.color;
        ctx.fill();
      }
      if (node === hover || node === selected) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = paint.ink;
        ctx.stroke();
      }
      if (node.url && semanticUrls.has(searchUrlKey(node.url))) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.r + 3, 0, Math.PI * 2);
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = paint.accent;
        ctx.stroke();
      }
      const named =
        node.kind !== "link" ||
        zoom >= 1.2 ||
        node === hover ||
        (active && near.has(node.id)) ||
        (query && node.label.toLowerCase().includes(query));
      if (!named) continue;
      ctx.save();
      ctx.translate(node.x, node.y + node.r + 4);
      ctx.scale(1 / zoom, 1 / zoom);
      ctx.globalAlpha = (dim ? 0.16 : 0.94) * nodeFade;
      ctx.fillStyle = paint.ink;
      ctx.font = "12px Segoe UI, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(clip(node.label, node.kind === "link" ? 22 : 26), 0, 0);
      ctx.restore();
    }
    ctx.restore();
    canvas.dataset.zoom = zoom.toFixed(3);
    canvas.dataset.panx = panX.toFixed(1);
    canvas.dataset.nodes = String(activeNodes.length);
  }

  function tick(dt) {
    const cool = Math.max(alpha, 0.02);

    for (const node of activeNodes) {
      if (node.state === "in") {
        node.fade = Math.min(1, node.fade + SPAWN_FADE_STEP * dt);
        if (node.fade >= 1) {
          node.state = "on";
          dirtyActive = true;
        }
      } else if (node.state === "out") {
        node.fade = Math.max(0, node.fade - SPAWN_FADE_STEP * dt);
        if (node.fade <= 0) {
          node.state = "off";
          dirtyActive = true;
        }
      }
    }

    for (let i = 0; i < activeNodes.length; i += 1) {
      const a = activeNodes[i];
      if (a.state === "out") continue;
      for (let j = i + 1; j < activeNodes.length; j += 1) {
        const b = activeNodes[j];
        if (b.state === "out") continue;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist2 = dx * dx + dy * dy;
        if (dist2 < 0.01) {
          dx = (j - i + 1) * 0.05;
          dy = 0.05;
          dist2 = dx * dx + dy * dy;
        }
        const dist = Math.sqrt(dist2);
        const separateProjects = isProject(a) && isProject(b) && (
          (a.kind === "category" && b.kind === "category")
          || (a.kind === "project" && b.kind === "project" && a.categoryId !== b.categoryId)
          || (a.kind === "category" && b.kind === "project" && a.categoryId !== b.categoryId)
          || (a.kind === "project" && b.kind === "category" && a.categoryId !== b.categoryId)
        );
        const push = ((separateProjects ? 700 : 420) * cool * dt) / dist2;
        const fx = (dx / dist) * push;
        const fy = (dy / dist) * push;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
        const gap = separateProjects ? 200 : a.r + b.r + 8;
        if (dist < gap) {
          const shove = ((gap - dist) / dist) * (separateProjects ? 0.5 : 0.28) * dt;
          a.vx -= dx * shove;
          a.vy -= dy * shove;
          b.vx += dx * shove;
          b.vy += dy * shove;
        } else if (separateProjects) {
          const gather = ((dist - gap) / dist) * 0.1 * cool * dt;
          a.vx += dx * gather;
          a.vy += dy * gather;
          b.vx -= dx * gather;
          b.vy -= dy * gather;
        }
      }
    }
    for (const edge of activeEdges) {
      if (edge.source.state === "out" || edge.target.state === "out") continue;
      const a = edge.source;
      const b = edge.target;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 1;
      const desired = edge.kind === "parent" ? 88 : 46;
      const mag = ((dist - desired) / dist) * 0.16 * (0.3 + cool) * dt;
      const fx = dx * mag;
      const fy = dy * mag;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
    for (const node of activeNodes) {
      if (node.state === "out") continue;
      const slot = linkSlots.get(node.id);
      if (!slot) continue;
      const targetX = slot.hub.x + Math.cos(slot.angle) * slot.radius;
      const targetY = slot.hub.y + Math.sin(slot.angle) * slot.radius;
      node.vx += (targetX - node.x) * 0.035 * cool * dt;
      node.vy += (targetY - node.y) * 0.035 * cool * dt;
    }
    for (const node of activeNodes) {
      if (node.kind === "category") continue;
      const category = categoryByNodeId.get(node.id);
      if (!category) continue;
      const dx = category.x - node.x;
      const dy = category.y - node.y;
      const dist = Math.hypot(dx, dy) || 1;
      if (node.state === "out") {
        const mag = 0.22 * (0.3 + cool) * dt;
        node.vx += dx * mag;
        node.vy += dy * mag;
        continue;
      }
      const leash = node.kind === "link" ? LINK_LEASH : PROJECT_LEASH;
      if (dist > leash) {
        const mag = ((dist - leash) / dist) * 0.3 * cool * dt;
        node.vx += dx * mag;
        node.vy += dy * mag;
      }
    }
    const damp = Math.pow(0.64, dt);
    for (const node of activeNodes) {
      node.vx += -node.x * 0.003 * cool * dt;
      node.vy += -node.y * 0.003 * cool * dt;
      node.vx *= damp;
      node.vy *= damp;
      const mass = node.kind === "link" ? 1 : 2.4;
      if (node.fixed) {
        node.vx = 0;
        node.vy = 0;
      } else {
        node.x += (node.vx * dt) / mass;
        node.y += (node.vy * dt) / mass;
      }
      positions.set(node.id, { x: node.x, y: node.y });
    }
    alpha *= Math.pow(0.955, dt);
    if (alpha < 0.02) alpha = 0;
  }

  function wake(amount) {
    alpha = Math.max(alpha, amount);
    if (!frame && running) frame = requestAnimationFrame(step);
  }

  function step(now) {
    frame = 0;
    stepping = true;
    if (!running) {
      stepping = false;
      return;
    }
    const dt = Math.min(2, Math.max(0.5, (now - (lastTime || now)) / 16.67));
    lastTime = now;
    if (dirtyActive) {
      refreshActive();
      dirtyActive = false;
    }
    const animating = alpha > 0 || transitionsActive();
    if (animating) tick(dt);
    applyCamera(now);
    if (!userMoved && alpha === 0 && !framed && !transitionsActive()) {
      framed = true;
      if (!selected && !camera) showAll();
    }
    draw();
    if (alpha > 0 || drag || camera || transitionsActive()) frame = requestAnimationFrame(step);
    stepping = false;
  }

  function resize() {
    const rect = canvas.parentElement?.getBoundingClientRect();
    viewWidth = Math.max(1, rect?.width || canvas.clientWidth || 1);
    viewHeight = Math.max(1, rect?.height || canvas.clientHeight || 1);
    if (!fitted && !userMoved && !selected && viewWidth > 40 && viewHeight > 40) {
      const target = cameraFor(activeNodes);
      zoom = target.zoom;
      panX = target.panX;
      panY = target.panY;
      fitted = true;
    }
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
      node.fixed = true;
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
        options.onHover?.(publish(next));
        draw();
      }
      return;
    }
    const dx = point.x - last.x;
    const dy = point.y - last.y;
    if (dx * dx + dy * dy > 9) {
      moved = true;
      userMoved = true;
      camera = null;
    }
    last = point;
    if (!moved) return;
    if (drag.type === "pan") {
      panX += dx;
      panY += dy;
      draw();
      return;
    }
    const world = screenToWorld(point.x, point.y);
    drag.node.x = world.x - drag.dx;
    drag.node.y = world.y - drag.dy;
    wake(0.5);
  }

  function onPointerUp() {
    const node = drag?.type === "node" ? drag.node : null;
    if (node) {
      node.fixed = false;
      node.vx = 0;
      node.vy = 0;
      if (!moved) {
        selected = node;
        options.onSelect?.(publish(node));
        focusNode(node);
        if (node.kind === "link") options.onOpen?.(publish(node));
      } else wake(0.3);
    } else if (drag?.type === "pan" && !moved && selected) {
      selected = null;
      options.onSelect?.(null);
      showAll();
    }
    drag = null;
    canvas.style.cursor = hover ? "pointer" : "grab";
  }

  function onPointerLeave() {
    if (drag) return;
    if (!hover) return;
    hover = null;
    canvas.style.cursor = "grab";
    options.onHover?.(null);
    draw();
  }

  function onWheel(event) {
    event.preventDefault();
    userMoved = true;
    camera = null;
    const point = localPoint(event);
    const prev = zoom;
    const next = Math.min(3, Math.max(0.35, zoom * Math.exp(-event.deltaY * 0.0011)));
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
    selected = node;
    options.onSelect?.(publish(node));
    focusNode(node);
    if (node.kind !== "category") options.onOpen?.(publish(node));
  }

  function onKey(event) {
    if (event.key !== "Escape" || event.target?.closest?.("input, textarea")) return;
    if (!selected) return;
    selected = null;
    options.onSelect?.(null);
    showAll();
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("dblclick", onDoubleClick);
  window.addEventListener("keydown", onKey);
  const observer = new ResizeObserver(() => resize());
  if (canvas.parentElement) observer.observe(canvas.parentElement);
  resize();
  wake(alpha);

  return {
    destroy() {
      running = false;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("dblclick", onDoubleClick);
      window.removeEventListener("keydown", onKey);
    },
    redraw() {
      draw();
    },
    setVisible(ids) {
      setVisible(ids);
    },
  };
}

function isProject(node) {
  return node.kind === "category" || node.kind === "project" || node.kind === "child" || node.kind === "suggestion";
}

function placeFresh(nodes, edges) {
  const categories = nodes.filter((node) => node.kind === "category");
  const hubs = categories.length
    ? categories
    : nodes.filter((node) => node.kind === "project" || node.kind === "suggestion");
  hubs.forEach((node, index) => {
    const angle = (index / Math.max(hubs.length, 1)) * Math.PI * 2 - Math.PI / 2;
    const ring = categories.length ? 220 + categories.length * 24 : 88 + hubs.length * 18;
    node.x = Math.cos(angle) * ring;
    node.y = Math.sin(angle) * ring;
  });
  if (categories.length) {
    for (const category of categories) {
      const children = edges
        .filter((edge) => edge.kind === "parent" && edge.source === category)
        .map((edge) => edge.target);
      children.forEach((project, index) => {
        const angle = (index / Math.max(children.length, 1)) * Math.PI * 2;
        const ring = 88 + children.length * 12;
        project.x = category.x + Math.cos(angle) * ring;
        project.y = category.y + Math.sin(angle) * ring;
      });
    }
  }
  for (const [index, node] of nodes.entries()) {
    if (node.kind !== "child") continue;
    const parent = edges.find((edge) => edge.kind === "parent" && edge.target === node)?.source;
    const angle = index * 0.9;
    node.x = (parent?.x || 0) + Math.cos(angle) * 72;
    node.y = (parent?.y || 0) + Math.sin(angle) * 72;
  }
  const groups = new Map();
  for (const node of nodes) {
    if (node.kind !== "link") continue;
    const hub = edges.find((edge) => edge.kind === "link" && edge.target === node)?.source;
    const list = groups.get(hub) || [];
    list.push(node);
    groups.set(hub, list);
  }
  for (const [hub, list] of groups) {
    list.forEach((node, index) => {
      const angle = (index / list.length) * Math.PI * 2;
      node.x = (hub?.x || 0) + Math.cos(angle) * 60;
      node.y = (hub?.y || 0) + Math.sin(angle) * 60;
    });
  }
}

function placeMissing(nodes, edges) {
  nodes.forEach((node, index) => {
    if (node.x || node.y || positions.has(node.id)) return;
    const anchor = edges.find((edge) => edge.source === node || edge.target === node);
    const other = anchor ? (anchor.source === node ? anchor.target : anchor.source) : null;
    const angle = index * 0.85;
    node.x = (other?.x || 0) + Math.cos(angle) * 68;
    node.y = (other?.y || 0) + Math.sin(angle) * 68;
  });
}

export function buildMountedModel(projects) {
  const model = graphModel({ projects });
  const projectCategory = new Map();
  const singleLinkProjects = new Set();
  for (const node of model.nodes) {
    if (node.kind !== "project") continue;
    projectCategory.set(node.id, String(node.categoryId || "uncategorized"));
    if ((node.links || []).length === 1) singleLinkProjects.add(node.id);
  }
  if (!singleLinkProjects.size) {
    annotateLinkCategories(model.nodes, projectCategory);
    return model;
  }
  const categoryByProject = new Map();
  for (const edge of model.edges) {
    if (edge.kind === "parent") categoryByProject.set(edge.target, edge.source);
  }
  const nodes = model.nodes.filter((node) => !(
    node.kind === "project" && singleLinkProjects.has(node.id)
  ));
  const edges = [];
  for (const edge of model.edges) {
    if (edge.kind === "parent" && singleLinkProjects.has(edge.target)) continue;
    if (edge.kind === "link" && singleLinkProjects.has(edge.source)) {
      const categoryNodeId = categoryByProject.get(edge.source);
      edges.push(categoryNodeId ? { ...edge, source: categoryNodeId } : edge);
      continue;
    }
    edges.push(edge);
  }
  annotateLinkCategories(nodes, projectCategory);
  return { nodes, edges };
}

function annotateLinkCategories(nodes, projectCategory) {
  for (const node of nodes) {
    if (node.kind !== "link") continue;
    const categoryId = projectCategory.get(node.projectId);
    if (categoryId) node.categoryId = categoryId;
  }
}
