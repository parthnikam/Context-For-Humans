import { graphModel } from "./graph-model.js";

const positions = new Map();
const LAYOUT = 3;
const mountedGraphs = new WeakMap();

function radius(node) {
  if (node.kind === "link") return 5;
  if (node.kind === "child") return 9;
  if (node.kind === "suggestion") return 8;
  return 12;
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

export function fillGraphDetail(host, node, onOpen, onEdit, projects = []) {
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
    const projectForm = document.createElement("form");
    projectForm.className = "graph-project-name";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.maxLength = 100;
    nameInput.value = node.label;
    nameInput.setAttribute("aria-label", "Project name");
    const renameButton = document.createElement("button");
    renameButton.type = "submit";
    renameButton.textContent = "Rename";
    projectForm.append(nameInput, renameButton);
    projectForm.addEventListener("submit", (event) => {
      event.preventDefault();
      onEdit?.({ type: "rename", projectId: node.projectId, name: nameInput.value });
    });
    host.append(projectForm);

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
      const moveSelect = document.createElement("select");
      moveSelect.className = "graph-detail-move";
      moveSelect.setAttribute("aria-label", `Move ${link.title || link.url} to another project`);
      moveSelect.append(new Option("Move to project...", ""));
      for (const project of projects) {
        if (project.id === node.projectId) continue;
        const option = new Option(project.name, project.id);
        moveSelect.append(option);
      }
      moveSelect.disabled = moveSelect.options.length === 1;
      moveSelect.addEventListener("change", () => {
        if (!moveSelect.value) return;
        onEdit?.({
          type: "move",
          projectId: node.projectId,
          targetProjectId: moveSelect.value,
          url: link.url,
        });
      });
      row.append(item, moveSelect);
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

export function mountGraph(canvas, model, options = {}) {
  const nodes = (model?.nodes || []).map((node) => ({
    ...node,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    r: radius(node),
    fixed: false,
  }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = (model?.edges || [])
    .map((edge) => ({ ...edge, source: byId.get(edge.source), target: byId.get(edge.target) }))
    .filter((edge) => edge.source && edge.target);
  const linkSlots = new Map();
  const linksByProject = new Map();
  for (const edge of edges) {
    if (edge.kind !== "link" || edge.target.kind !== "link") continue;
    const links = linksByProject.get(edge.source.id) || [];
    links.push(edge.target);
    linksByProject.set(edge.source.id, links);
  }
  for (const [projectId, links] of linksByProject) {
    const hub = byId.get(projectId);
    if (!hub) continue;
    const orbitRadius = Math.max(70, links.length * 11);
    links.forEach((node, index) => {
      linkSlots.set(node.id, {
        hub,
        angle: (index / links.length) * Math.PI * 2 - Math.PI / 2,
        radius: orbitRadius,
      });
    });
  }
  const family = new Set(
    edges
      .filter((edge) => edge.kind === "parent")
      .map((edge) => `${edge.source.id}\0${edge.target.id}`),
  );
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

  function hit(wx, wy) {
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index];
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
    if (!query) return null;
    const matches = new Set(
      nodes
        .filter((node) => `${node.label} ${node.intent || ""}`.toLowerCase().includes(query))
        .map((node) => node.id),
    );
    for (const edge of edges) {
      if (matches.has(edge.source.id) || matches.has(edge.target.id)) {
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
    for (const edge of edges) {
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
    const list = nodes.filter((item) => ids.has(item.id));
    animateCamera(cameraFor(list.length ? list : [node]));
  }

  function showAll() {
    animateCamera(cameraFor(nodes));
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

    for (const edge of edges) {
      const dim = faded(edge.source.id) || faded(edge.target.id);
      const hot = active && near.has(edge.source.id) && near.has(edge.target.id);
      ctx.globalAlpha = dim ? 0.07 : hot ? 1 : 0.72;
      ctx.strokeStyle = hot ? paint.accent : paint.muted;
      ctx.lineWidth = hot ? 1.8 : 1.25;
      ctx.beginPath();
      ctx.moveTo(edge.source.x, edge.source.y);
      ctx.lineTo(edge.target.x, edge.target.y);
      ctx.stroke();
    }

    const query = String(options.getQuery?.() || "").trim().toLowerCase();
    for (const node of nodes) {
      const dim = faded(node.id);
      ctx.globalAlpha = dim ? 0.12 : 1;
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
        ctx.fillStyle = node.color;
        ctx.fill();
      }
      if (node === hover || node === selected) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = paint.ink;
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
      ctx.globalAlpha = dim ? 0.16 : 0.94;
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
    canvas.dataset.nodes = String(nodes.length);
  }

  function tick(dt) {
    const cool = Math.max(alpha, 0.02);
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist2 = dx * dx + dy * dy;
        if (dist2 < 0.01) {
          dx = (j - i + 1) * 0.05;
          dy = 0.05;
          dist2 = dx * dx + dy * dy;
        }
        const dist = Math.sqrt(dist2);
        const separateProjects =
          isProject(a) && isProject(b) && !family.has(`${a.id}\0${b.id}`) && !family.has(`${b.id}\0${a.id}`);
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
    for (const edge of edges) {
      const a = edge.source;
      const b = edge.target;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 1;
      const desired = edge.kind === "parent" ? 76 : 64;
      const mag = ((dist - desired) / dist) * 0.16 * (0.3 + cool) * dt;
      const fx = dx * mag;
      const fy = dy * mag;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
    for (const node of nodes) {
      const slot = linkSlots.get(node.id);
      if (!slot) continue;
      const targetX = slot.hub.x + Math.cos(slot.angle) * slot.radius;
      const targetY = slot.hub.y + Math.sin(slot.angle) * slot.radius;
      node.vx += (targetX - node.x) * 0.035 * cool * dt;
      node.vy += (targetY - node.y) * 0.035 * cool * dt;
    }
    const damp = Math.pow(0.64, dt);
    for (const node of nodes) {
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
    if (alpha > 0) tick(dt);
    applyCamera(now);
    if (!userMoved && alpha === 0 && !framed) {
      framed = true;
      if (!selected && !camera) showAll();
    }
    draw();
    if (alpha > 0 || drag || camera) frame = requestAnimationFrame(step);
    stepping = false;
  }

  function resize() {
    const rect = canvas.parentElement?.getBoundingClientRect();
    viewWidth = Math.max(1, rect?.width || canvas.clientWidth || 1);
    viewHeight = Math.max(1, rect?.height || canvas.clientHeight || 1);
    if (!fitted && !userMoved && !selected && viewWidth > 40 && viewHeight > 40) {
      const target = cameraFor(nodes);
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
    options.onOpen?.(publish(node));
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
  };
}

function isProject(node) {
  return node.kind === "project" || node.kind === "child" || node.kind === "suggestion";
}

function placeFresh(nodes, edges) {
  const hubs = nodes.filter((node) => node.kind === "project" || node.kind === "suggestion");
  hubs.forEach((node, index) => {
    const angle = (index / Math.max(hubs.length, 1)) * Math.PI * 2 - Math.PI / 2;
    const ring = 88 + hubs.length * 18;
    node.x = Math.cos(angle) * ring;
    node.y = Math.sin(angle) * ring;
  });
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

export function renderGraph(host, projects, detailHost, onStatus, onOpen, onEdit) {
  mountedGraphs.get(host)?.destroy();
  host.replaceChildren();

  const stage = document.createElement("div");
  stage.className = "graph-stage";
  const canvas = document.createElement("canvas");
  canvas.className = "graph-canvas";
  canvas.setAttribute("aria-label", "Interactive project and conversation graph");
  const hud = document.createElement("div");
  hud.className = "graph-hud";
  const find = document.createElement("input");
  find.className = "graph-find";
  find.type = "search";
  find.placeholder = "Find a project or conversation";
  find.setAttribute("aria-label", "Find in the graph");
  hud.append(find);

  detailHost.className = "graph-detail";
  detailHost.hidden = true;
  stage.append(canvas, hud, detailHost);
  host.append(stage);

  const model = graphModel({ projects });
  if (!model.nodes.length) {
    const empty = document.createElement("p");
    empty.className = "empty-graph";
    empty.textContent = "Extract conversations or import a CSV to build the graph.";
    stage.append(empty);
    return;
  }

  const handle = mountGraph(canvas, model, {
    getQuery: () => find.value,
    onSelect(node) {
      fillGraphDetail(detailHost, node, onOpen, onEdit, projects);
    },
    onOpen,
  });
  mountedGraphs.set(host, handle);
  find.addEventListener("input", () => handle.redraw());
  onStatus?.("Drag to move. Scroll to zoom. Click a node to inspect it; click a conversation to open it.");
}
