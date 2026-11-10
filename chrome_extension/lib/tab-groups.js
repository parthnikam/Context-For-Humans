const GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
let groupingDepth = 0;

export function samePage(left, right) {
  if (!left || !right) return false;
  try {
    const a = new URL(left);
    const b = new URL(right);
    a.hash = "";
    b.hash = "";
    return a.href === b.href;
  } catch {
    return left === right;
  }
}

export function shouldSkipUrl(url) {
  if (!url) return true;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  return (
    parsed.protocol === "chrome:"
    || parsed.protocol === "chrome-extension:"
    || parsed.protocol === "chrome-untrusted:"
    || parsed.protocol === "edge:"
    || parsed.protocol === "about:"
    || parsed.protocol === "devtools:"
    || parsed.protocol === "view-source:"
  );
}

export function safeIcon(url) {
  if (!url) return "";
  if (url.startsWith("data:image/")) return url;
  if (url.startsWith("https://") || url.startsWith("http://")) return url;
  return "";
}

export function isUntitledTitle(title) {
  const value = String(title || "").trim().toLowerCase();
  if (!value || value === "new tab" || value === "about:blank") return true;
  return /^untitled(?:\s+(document|spreadsheet|presentation|form|drawing|file|page|tab))?(?:\s*[-|–—].*)?$/.test(value);
}

export function projectGroups(projects, tabs) {
  const buckets = new Map();
  for (const tab of tabs || []) {
    for (const project of projects || []) {
      const link = (project.links || []).find((item) => samePage(item.url, tab.url));
      if (!link) continue;
      const bucket = buckets.get(project.id) || { title: project.name || "Untitled", tabIds: [] };
      bucket.tabIds.push(tab.id);
      buckets.set(project.id, bucket);
      break;
    }
  }
  return [...buckets.values()];
}

export function pullUntitled(groups, tabs) {
  const claimed = new Set((groups || []).flatMap((group) => group.tabIds));
  const ids = [];
  for (const tab of tabs || []) {
    if (tab?.id == null || claimed.has(tab.id) || !isUntitledTitle(tab.title)) continue;
    ids.push(tab.id);
  }
  if (!ids.length) return groups || [];
  const next = (groups || []).map((group) => ({ title: group.title, tabIds: [...group.tabIds] }));
  const existing = next.find((group) => group.title === "Untitled");
  if (existing) existing.tabIds.push(...ids);
  else next.push({ title: "Untitled", tabIds: ids });
  return next;
}

export function categoryHome(tabs, preferredWindowId = null) {
  if (preferredWindowId != null) return preferredWindowId;
  const counts = new Map();
  for (const tab of tabs || []) {
    if (tab?.id == null || tab.windowId == null) continue;
    counts.set(tab.windowId, (counts.get(tab.windowId) || 0) + 1);
  }
  let home = null;
  let best = -1;
  for (const [windowId, count] of counts) {
    if (count > best || (count === best && windowId < home)) {
      best = count;
      home = windowId;
    }
  }
  return home;
}

export function gatherPlan(tabs, homeWindowId) {
  const ordered = (tabs || [])
    .filter((tab) => tab?.id != null && tab.windowId != null)
    .sort((left, right) => {
      const leftHome = left.windowId === homeWindowId ? 0 : 1;
      const rightHome = right.windowId === homeWindowId ? 0 : 1;
      if (leftHome !== rightHome) return leftHome - rightHome;
      return (left.index ?? 0) - (right.index ?? 0);
    });
  const homeIndexes = ordered
    .filter((tab) => tab.windowId === homeWindowId && Number.isInteger(tab.index))
    .map((tab) => tab.index);
  return {
    homeWindowId,
    index: homeIndexes.length ? Math.min(...homeIndexes) : -1,
    groupIds: ordered.map((tab) => tab.id),
  };
}

export function groupsAfterRemoval(groups, removedTitles) {
  const dropped = new Set(
    (removedTitles || []).map((title) => String(title || "").trim()).filter(Boolean),
  );
  if (!dropped.size) return groups || [];
  return (groups || []).filter((group) => !dropped.has(String(group?.title || "").trim()));
}

export function mergeTrailGroups(groups, trails) {
  const used = new Set((groups || []).flatMap((group) => group.tabIds));
  const next = (groups || []).map((group) => ({ title: group.title, tabIds: [...group.tabIds] }));
  for (const trail of trails || []) {
    const title = String(trail?.label || "").trim() || "Untitled";
    const ids = [];
    for (const id of trail?.tab_ids || []) {
      const numeric = Number(id);
      if (!Number.isInteger(numeric) || used.has(numeric)) continue;
      used.add(numeric);
      ids.push(numeric);
    }
    if (ids.length === 0) continue;
    const existing = next.find((group) => group.title === title);
    if (existing) existing.tabIds.push(...ids);
    else next.push({ title, tabIds: ids });
  }
  return next;
}

export function reopenPlan(links, openTabs) {
  const reuse = [];
  const create = [];
  const pinned = [];
  const claimed = new Set();
  const seen = [];
  for (const link of links || []) {
    const url = String(link?.url || "").trim();
    if (!url || seen.some((item) => samePage(item, url))) continue;
    seen.push(url);
    const match = (openTabs || []).find(
      (tab) => tab?.id != null && !claimed.has(tab.id) && samePage(tab.url, url),
    );
    if (!match) {
      create.push(url);
      continue;
    }
    claimed.add(match.id);
    const item = { id: match.id, windowId: match.windowId, url: match.url };
    if (match.pinned) pinned.push(item);
    else reuse.push(item);
  }
  return { reuse, create, pinned };
}

export async function listChromeGroups() {
  const [groups, tabs] = await Promise.all([chrome.tabGroups.query({}), chrome.tabs.query({})]);
  const visible = tabs.filter((tab) => tab.id != null && !tab.pinned && !shouldSkipUrl(tab.url));
  const listed = groups
    .map((group) => ({
      id: group.id,
      title: group.title || "Untitled",
      color: group.color || "grey",
      windowId: group.windowId,
      tabs: visible
        .filter((tab) => tab.groupId === group.id)
        .sort((left, right) => left.index - right.index)
        .map(tabSnapshot),
    }))
    .filter((group) => group.tabs.length > 0)
    .sort((left, right) => left.windowId - right.windowId || left.title.localeCompare(right.title));
  const loose = visible
    .filter((tab) => tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE)
    .sort((left, right) => left.windowId - right.windowId || left.index - right.index)
    .map(tabSnapshot);
  return { groups: listed, loose };
}

export async function focusTab(tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id)) throw new Error("That tab is no longer open.");
  const tab = await chrome.tabs.get(id);
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(id, { active: true });
}

export async function focusProjectGroup(title) {
  const name = String(title || "").trim();
  if (!name) return false;
  const groups = await chrome.tabGroups.query({ title: name });
  if (!groups.length) return false;
  const tabs = await chrome.tabs.query({ groupId: groups[0].id });
  const target = tabs.find((tab) => tab?.id != null);
  if (!target) return false;
  await chrome.windows.update(target.windowId, { focused: true });
  await chrome.tabs.update(target.id, { active: true });
  return true;
}

export async function ungroupProjectTabs(title) {
  const name = String(title || "").trim();
  if (!name) return 0;
  let ungrouped = 0;
  const groups = await chrome.tabGroups.query({ title: name });
  for (const group of groups) {
    const tabs = await chrome.tabs.query({ groupId: group.id });
    const ids = tabs.filter((tab) => tab?.id != null && !tab.pinned).map((tab) => tab.id);
    if (ids.length) {
      await chrome.tabs.ungroup(ids);
      ungrouped += ids.length;
    }
  }
  return ungrouped;
}

export async function applyChromeGroups(groups) {
  groupingDepth += 1;
  try {
    return await applyChromeGroupsNow(groups);
  } finally {
    groupingDepth -= 1;
  }
}

function tabSnapshot(tab) {
  return {
    id: tab.id,
    title: tab.title || tab.url || "Untitled",
    url: tab.url || "",
    favIconUrl: safeIcon(tab.favIconUrl),
  };
}

async function applyChromeGroupsNow(groups) {
  const open = await chrome.tabs.query({});
  const live = new Map(
    open.filter((tab) => tab.id != null && !tab.pinned).map((tab) => [tab.id, tab]),
  );
  const claimed = new Map();
  for (const group of groups) {
    for (const id of group.tabIds) claimed.set(id, group.title);
  }
  const usedColors = new Set();
  const failures = [];
  let made = 0;
  for (const group of groups) {
    try {
      const grouped = await gatherCategory(group, live, claimed, usedColors);
      if (grouped) made += 1;
    } catch (error) {
      failures.push(error.message || "Something went wrong.");
    }
  }
  if (made === 0 && failures.length > 0) throw new Error(failures[0]);
  return { made, warning: failures.join(" ") };
}

async function gatherCategory(group, live, claimed, usedColors) {
  const members = new Map();
  const add = (tab) => {
    if (!tab || tab.pinned || tab.id == null || tab.windowId == null) return;
    if (shouldSkipUrl(tab.url)) return;
    const owner = claimed.get(tab.id);
    if (owner && owner !== group.title) return;
    members.set(tab.id, tab);
  };
  for (const id of group.tabIds) add(live.get(id));
  const named = await chrome.tabGroups.query({ title: group.title });
  for (const existing of named) {
    const sitting = await chrome.tabs.query({ groupId: existing.id });
    for (const tab of sitting) add(tab);
  }
  if (members.size === 0) return false;

  const list = [...members.values()];
  const preferred = (await largestNamedGroup(named))?.windowId ?? null;
  const home = categoryHome(list, preferred);
  const plan = gatherPlan(list, home);
  const homeGroup = named.find((item) => item.windowId === home);
  const abroad = plan.groupIds.filter((id) => members.get(id)?.windowId !== home);
  try {
    if (abroad.length) await chrome.tabs.move(abroad, { windowId: home, index: plan.index });
    if (plan.groupIds.length > 1) await chrome.tabs.move(plan.groupIds, { index: plan.index });
  } catch (error) {
    let groupedAny = false;
    let lastError = error;
    for (const tab of list) {
      try {
        await groupTabsInWindow(tab.windowId, [tab.id], group.title, usedColors);
        groupedAny = true;
      } catch (again) {
        lastError = again;
      }
    }
    if (!groupedAny) throw lastError;
    return true;
  }
  try {
    await groupTabsInWindow(home, plan.groupIds, group.title, usedColors, homeGroup?.id);
  } catch {
    await groupTabsInWindow(home, plan.groupIds, group.title, usedColors);
  }
  return true;
}

async function largestNamedGroup(groups) {
  let best = null;
  let bestCount = -1;
  for (const group of groups || []) {
    const count = (await chrome.tabs.query({ groupId: group.id })).length;
    if (count > bestCount) {
      best = group;
      bestCount = count;
    }
  }
  return best;
}

async function groupTabsInWindow(windowId, tabIds, title, usedColors, groupId) {
  if (!tabIds.length) return;
  groupingDepth += 1;
  try {
    const named = groupId ? { id: groupId } : (await chrome.tabGroups.query({ windowId, title }))[0];
    if (named) {
      await chrome.tabs.group({ groupId: named.id, tabIds });
      return;
    }
    const created = await chrome.tabs.group({
      tabIds,
      createProperties: { windowId },
    });
    const color = randomColor(usedColors);
    usedColors.add(color);
    await chrome.tabGroups.update(created, { title, color });
  } finally {
    groupingDepth -= 1;
  }
}

function randomColor(used) {
  const free = GROUP_COLORS.filter((color) => !used.has(color));
  const pool = free.length > 0 ? free : GROUP_COLORS;
  return pool[Math.floor(Math.random() * pool.length)];
}

export async function openProjectTabs(project) {
  const links = project.links || [];
  if (!links.length) throw new Error(`${project.name} has no links to open.`);
  const current = await chrome.windows.getLastFocused();
  const openTabs = await chrome.tabs.query({});
  const plan = reopenPlan(links, openTabs);
  const ids = [];
  for (const item of plan.reuse) ids.push(await bringTabToWindow(item, current.id));
  for (const url of plan.create) {
    const created = await chrome.tabs.create({ url, windowId: current.id, active: false });
    ids.push(created.id);
  }
  const fresh = await chrome.tabs.query({});
  const byWindow = new Map();
  for (const id of ids) {
    const tab = fresh.find((item) => item.id === id);
    if (!tab || tab.pinned) continue;
    const list = byWindow.get(tab.windowId) || [];
    list.push(id);
    byWindow.set(tab.windowId, list);
  }
  const usedColors = new Set();
  for (const [windowId, tabIds] of byWindow) {
    groupingDepth += 1;
    try {
      const named = (await chrome.tabGroups.query({ windowId, title: project.name }))[0];
      if (named) await chrome.tabs.group({ groupId: named.id, tabIds });
      else {
        const created = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
        const color = randomColor(usedColors);
        usedColors.add(color);
        await chrome.tabGroups.update(created, { title: project.name, color });
      }
    } finally {
      groupingDepth -= 1;
    }
  }
  const focusId = fresh.find((tab) => ids.includes(tab.id) && tab.windowId === current.id)?.id || ids[0];
  if (focusId != null) {
    const focus = fresh.find((tab) => tab.id === focusId) || (await chrome.tabs.get(focusId));
    await chrome.windows.update(focus.windowId, { focused: true });
    await chrome.tabs.update(focus.id, { active: true });
  }
  return { name: project.name, opened: ids.length + plan.pinned.length };
}

async function bringTabToWindow(tab, windowId) {
  if (tab.windowId === windowId) return tab.id;
  try {
    const moved = await chrome.tabs.move(tab.id, { windowId, index: -1 });
    const next = Array.isArray(moved) ? moved[0] : moved;
    return next?.id || tab.id;
  } catch {
    return tab.id;
  }
}