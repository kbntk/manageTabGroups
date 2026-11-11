// Tab group management view.
// All groups in the current window are rendered as columns;
// clicking a group (or a nav button) makes it the active, enlarged one.

// "page": the manager tab. "panel": overlay iframe on a web page. "strip": bottom strip iframe on a web page.
const MODE = new URLSearchParams(location.search).get("mode") || "page";
document.body.dataset.mode = MODE;
if (MODE === "panel") {
  // The panel's document must be transparent too, not only its body
  document.documentElement.style.background = "transparent";
}

// The panel's close button. In panel mode it is moved onto the active group window (top right corner).
const closeButton = document.getElementById("minimize");

// Panel mode: "..." and "×" at the top right of the active group window. The "..." menu
// offers "Ungroup tabs" for the active group.
const panelActions = MODE === "panel" ? buildPanelActions() : null;

const COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
const TAB_GROUP_ID_NONE = -1; // browser.tabGroups.TAB_GROUP_ID_NONE

let selectedGroupId = null;
let lastData = null;            // last loaded window data, to redraw the strip
let stripActiveGroupId = null;  // strip mode: group selected in the open panel, shown highlighted
let scrollStripToActive = false; // set when the active group changes, so the strip scrolls to it
let stripFilter = "";            // lowercased text from the strip's filter field ("" = show all)
let scrollToSelected = false; // set when the selection changes, so the active group is centered
let draggedTab = null; // { id, index, groupId } while a tab row is being dragged
let draggedGroup = null; // { id, tabIds, start, count } while a group block is dragged in the strip
let draggedStripTab = null; // { id, index } while an ungrouped tab is dragged in the strip
let draggedPanelGroup = null; // { id, title, color, tabIds, start, count } while a group's bar is dragged in the panel

async function loadData() {
  const win = await api.windows.getCurrent();
  const groups = await api.tabGroups.query({ windowId: win.id });
  const tabs = await api.tabs.query({ windowId: win.id });
  const activeTab = tabs.find(t => t.active);
  return { windowId: win.id, groups, tabs, activeTab };
}

function render(data) {
  lastData = data;
  const { groups, tabs } = data;
  if (selectedGroupId === null && groups.length > 0) {
    selectedGroupId = groups[0].id;
    scrollToSelected = true;
  }

  // Forget selected tabs that no longer exist
  for (const id of [...selectedTabIds]) {
    if (!tabs.some(t => t.id === id)) selectedTabIds.delete(id);
  }

  renderNav(groups);
  updateSelectionBar();

  const container = document.getElementById("groups");
  container.textContent = "";

  groups.forEach((group, index) => {
    const groupTabs = tabs.filter(t => t.groupId === group.id);
    const groupEl = renderGroup(group, groupTabs, data);

    if (group.id !== selectedGroupId) {
      container.appendChild(groupEl);
      return;
    }

    // Selected group: wrap it with "<" / ">" so the buttons center on the group's height
    const wrap = document.createElement("div");
    wrap.className = "group-wrap";
    if (index > 0) {
      wrap.appendChild(createSwitchButton("<", groups[index - 1].id, "Previous group"));
    }
    wrap.appendChild(groupEl);
    if (index < groups.length - 1) {
      wrap.appendChild(createSwitchButton(">", groups[index + 1].id, "Next group"));
    }
    container.appendChild(wrap);
  });

  renderStrip(data);

  if (MODE === "panel") {
    // Close button sits on the active group's top right corner (or at the body if no group)
    const host = container.querySelector(".group.selected") || document.body;
    host.appendChild(panelActions);

    postPanelBounds();
    // Tell the strip which group is active in the panel
    sendToEmbedder({ type: "mtg-active", groupId: selectedGroupId });
  }

  if (scrollToSelected) {
    scrollToSelected = false;
    // Scroll only the groups row horizontally. scrollIntoView would also scroll the
    // page or iframe vertically and push the title out of view.
    const selectedEl = container.querySelector(".group.selected");
    if (selectedEl) {
      const box = selectedEl.getBoundingClientRect();
      const rowBox = container.getBoundingClientRect();
      const offset = (box.left + box.width / 2) - (rowBox.left + container.clientWidth / 2);
      container.scrollLeft += offset;
    }
  }
}

// Make a group the active one and center it horizontally
function selectGroup(groupId) {
  selectedGroupId = groupId;
  scrollToSelected = true;
  refresh();
}

// "<" / ">" button beside the selected group: switches to a neighbouring group
function createSwitchButton(label, targetGroupId, title) {
  const button = document.createElement("button");
  button.className = "switch-button";
  button.textContent = label;
  button.title = title;
  button.addEventListener("click", () => selectGroup(targetGroupId));
  return button;
}

function renderNav(groups) {
  const nav = document.getElementById("group-nav");
  nav.textContent = "";
  for (const group of groups) {
    const btn = document.createElement("button");
    btn.textContent = group.title || `Group ${group.id}`;
    btn.classList.toggle("active", group.id === selectedGroupId);
    btn.addEventListener("click", () => selectGroup(group.id));
    nav.appendChild(btn);
  }
}

function renderGroup(group, groupTabs, data) {
  const el = document.createElement("section");
  el.className = "group";
  el.classList.toggle("selected", group.id === selectedGroupId);
  el.style.borderTopColor = group.color; // Firefox color names are not always valid CSS colors; refine later

  // Active group: a thicker colored bar at the top. Drag it left or right to reorder groups.
  if (group.id === selectedGroupId) {
    const bar = document.createElement("div");
    bar.className = "group-handle";
    bar.draggable = true;
    bar.title = "Drag to reorder groups";
    bar.style.background = CSS_COLORS[group.color] || "#999";

    bar.addEventListener("dragstart", (event) => {
      event.stopPropagation();
      draggedPanelGroup = {
        id: group.id,
        title: group.title,
        color: group.color,
        tabIds: groupTabs.map(t => t.id),
        start: Math.min(...groupTabs.map(t => t.index)),
        count: groupTabs.length,
      };
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(group.id)); // Firefox needs data to start a drag
      el.classList.add("dragging");
    });
    bar.addEventListener("dragend", () => {
      draggedPanelGroup = null;
      clearDropMarkers();
      el.classList.remove("dragging");
    });
    el.appendChild(bar);
  }

  // Other groups accept a dropped group, before or after them
  el.addEventListener("dragover", (event) => {
    if (!draggedPanelGroup || draggedPanelGroup.id === group.id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    clearDropMarkers();
    el.classList.add(isLeftHalf(el, event) ? "drop-before" : "drop-after");
  });
  el.addEventListener("dragleave", () => {
    el.classList.remove("drop-before", "drop-after");
  });
  el.addEventListener("drop", async (event) => {
    event.preventDefault();
    if (!draggedPanelGroup || draggedPanelGroup.id === group.id) return;
    const before = isLeftHalf(el, event);
    const dragged = draggedPanelGroup;
    draggedPanelGroup = null;
    await moveGroupBeside(dragged, groupTabs, before);
    refresh();
  });

  // Clicking anywhere on the group makes it the active one (ignore clicks on controls)
  el.addEventListener("click", (event) => {
    if (event.target.closest("button, select, input")) return;
    if (selectedGroupId === group.id) return;
    selectGroup(group.id);
  });

  // Header: title (click to rename) + "..." menu
  const header = document.createElement("h2");

  const title = document.createElement("span");
  title.textContent = group.title || `Group name ${group.id}`;
  title.title = "Rename group";
  title.addEventListener("click", () => openRenameDialog(group));

  const menuWrap = document.createElement("div");
  menuWrap.className = "tab-menu";

  const menuButton = document.createElement("button");
  menuButton.className = "menu-button";
  menuButton.textContent = "...";
  menuButton.title = "Group actions";

  const menu = document.createElement("div");
  menu.className = "menu";
  menu.hidden = true;
  menu.addEventListener("click", (event) => event.stopPropagation());

  const goItem = document.createElement("button");
  goItem.textContent = "Go to group";
  goItem.addEventListener("click", () => goToGroup(groupTabs));

  const renameItem = document.createElement("button");
  renameItem.textContent = "Rename group";
  renameItem.addEventListener("click", () => openRenameDialog(group));

  const colorRow = document.createElement("label");
  colorRow.className = "menu-row";
  colorRow.textContent = "Color ";

  const colorSelect = document.createElement("select");
  colorSelect.className = "color";
  for (const color of COLORS) {
    const opt = document.createElement("option");
    opt.value = color;
    opt.textContent = color;
    if (color === group.color) opt.selected = true;
    colorSelect.appendChild(opt);
  }
  colorSelect.addEventListener("change", async () => {
    await api.tabGroups.update(group.id, { color: colorSelect.value });
    refresh();
  });
  colorRow.appendChild(colorSelect);

  menu.append(goItem, renameItem, colorRow);
  menuButton.addEventListener("click", (event) => {
    event.stopPropagation();
    const wasHidden = menu.hidden;
    closeAllMenus();
    menu.hidden = !wasHidden;
  });

  menuWrap.append(menuButton, menu);
  header.append(title, menuWrap);
  el.appendChild(header);

  // Tab list
  const list = document.createElement("ul");
  for (const tab of groupTabs) {
    const li = document.createElement("li");

    const name = document.createElement("span");
    name.className = "title";
    name.textContent = tab.title || tab.url;
    name.title = tab.url;

    // "..." menu with per-tab actions
    const tabMenuWrap = document.createElement("div");
    tabMenuWrap.className = "tab-menu";

    const tabMenuButton = document.createElement("button");
    tabMenuButton.className = "menu-button";
    tabMenuButton.textContent = "...";
    tabMenuButton.title = "More actions";

    const tabMenu = document.createElement("div");
    tabMenu.className = "menu";
    tabMenu.hidden = true;
    tabMenu.addEventListener("click", (event) => event.stopPropagation());

    const removeItem = document.createElement("button");
    removeItem.textContent = "Remove tab from group";
    removeItem.addEventListener("click", async () => {
      await api.tabs.ungroup(tab.id);
      refresh();
    });

    tabMenu.appendChild(removeItem);
    tabMenuButton.addEventListener("click", (event) => {
      event.stopPropagation();
      const wasHidden = tabMenu.hidden;
      closeAllMenus();
      tabMenu.hidden = !wasHidden;
    });

    tabMenuWrap.append(tabMenuButton, tabMenu);
    // A single click on the tab's title switches to that tab
    name.addEventListener("click", () => goToTab(tab));

    // Drag a tab row to reorder tabs inside the group
    li.draggable = true;
    li.addEventListener("dragstart", (event) => {
      draggedTab = { id: tab.id, index: tab.index, groupId: tab.groupId };
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(tab.id)); // Firefox needs data to start a drag
      li.classList.add("dragging");
    });
    li.addEventListener("dragend", () => {
      draggedTab = null;
      clearDropMarkers();
      li.classList.remove("dragging");
    });
    li.addEventListener("dragover", (event) => {
      if (!draggedTab || draggedTab.groupId !== group.id || draggedTab.id === tab.id) return;
      event.preventDefault(); // allow dropping here
      event.dataTransfer.dropEffect = "move";
      clearDropMarkers();
      li.classList.add(isUpperHalf(li, event) ? "drop-before" : "drop-after");
    });
    li.addEventListener("dragleave", () => {
      li.classList.remove("drop-before", "drop-after");
    });
    li.addEventListener("drop", async (event) => {
      event.preventDefault();
      if (!draggedTab || draggedTab.groupId !== group.id || draggedTab.id === tab.id) return;

      const movedId = draggedTab.id;
      const from = draggedTab.index;
      const target = tab.index;
      const before = isUpperHalf(li, event);
      draggedTab = null;

      // tabs.move uses the final index in the window. Removing the dragged tab
      // shifts later tabs by one, so adjust the target index accordingly.
      let newIndex;
      if (before) {
        newIndex = from < target ? target - 1 : target;
      } else {
        newIndex = from < target ? target : target + 1;
      }

      await api.tabs.move(movedId, { index: newIndex });
      await restoreGroupMembership(group.id, [movedId], { title: group.title, color: group.color });
      refresh();
    });

    // Checkbox: selects the tab for the copy/move actions
    const check = document.createElement("input");
    check.type = "checkbox";
    check.title = "Select tab";
    check.checked = selectedTabIds.has(tab.id);
    check.addEventListener("change", () => {
      if (check.checked) selectedTabIds.add(tab.id);
      else selectedTabIds.delete(tab.id);
      updateSelectionBar();
    });

    // Page icon between the checkbox and the title
    const icon = document.createElement("img");
    icon.className = "tab-favicon";
    icon.alt = "";
    if (tab.favIconUrl) icon.src = tab.favIconUrl;
    icon.addEventListener("error", () => icon.remove()); // no icon: leave the space empty

    li.append(check, icon, name, tabMenuWrap);
    list.appendChild(li);
  }
  el.appendChild(list);

  // Open the picker listing tabs that belong to no group
  const add = document.createElement("button");
  add.className = "round add";
  add.textContent = "+";
  add.title = "Add tabs to this group";
  add.addEventListener("click", () => openTabPicker(group));
  el.appendChild(add);

  return el;
}

// Move a block of consecutive tabs (starting at window index `start`) so that it
// starts at window index `newStart`. Tabs are moved one at a time: a single-tab
// move's index is its final position, so the order of the moves is chosen to
// keep the remaining positions predictable. Moving a list of tabs in one call
// put the block at a different place than requested.
async function moveTabBlock(tabIds, start, newStart) {
  if (newStart < start) {
    // Moving left: first tab first, each lands before the not-yet-moved ones
    for (let i = 0; i < tabIds.length; i++) {
      await api.tabs.move(tabIds[i], { index: newStart + i });
    }
  } else {
    // Moving right: last tab first, so earlier tabs are not shifted
    for (let i = tabIds.length - 1; i >= 0; i--) {
      await api.tabs.move(tabIds[i], { index: newStart + i });
    }
  }
}

// Firefox can drop moved tabs out of their group. Put them back into it.
// Returns the id of the group the tabs ended up in. That id changes only if the
// original group no longer exists, e.g. after all its tabs were ungrouped.
async function restoreGroupMembership(groupId, tabIds, { title, color } = {}) {
  const tabs = await Promise.all(tabIds.map(id => api.tabs.get(id)));
  if (tabs.every(t => t.groupId === groupId)) return groupId;

  let groupExists = true;
  try {
    await api.tabGroups.get(groupId);
  } catch {
    groupExists = false;
  }

  if (groupExists) {
    await api.tabs.group({ tabIds, groupId });
    return groupId;
  }

  const newGroupId = await api.tabs.group({ tabIds });
  const props = {};
  if (title) props.title = title;
  if (color) props.color = color;
  if (Object.keys(props).length > 0) {
    await api.tabGroups.update(newGroupId, props);
  }
  return newGroupId;
}

// Return a navigable URL for the text, or null if it is not a URL.
// Accepts full http(s) URLs and bare domains such as "example.com/path".
function toUrl(text) {
  const value = text.trim();
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  } catch {
    // not an absolute URL, try a bare domain below
  }
  if (!/\s/.test(value) && value.includes(".")) {
    try {
      const url = new URL("https://" + value);
      if (url.hostname.includes(".")) return url.href;
    } catch {
      // not a domain either
    }
  }
  return null;
}

// Open a new tab in the group: the URL if the text is one, otherwise a search
// with the default search engine. The new tab is added to the group.
async function addNewTabToGroup(group, text) {
  const url = toUrl(text);
  if (url) {
    const tab = await api.tabs.create({ url, windowId: group.windowId, active: true });
    await api.tabs.group({ tabIds: [tab.id], groupId: group.id });
    return;
  }

  // Search opens the tab itself, so find the tab that appeared and group it
  const before = new Set((await api.tabs.query({ windowId: group.windowId })).map(t => t.id));
  await api.search.search({ query: text, disposition: "NEW_TAB" });
  const created = (await api.tabs.query({ windowId: group.windowId }))
    .filter(t => !before.has(t.id));
  if (created.length > 0) {
    await api.tabs.group({ tabIds: created.map(t => t.id), groupId: group.id });
  }
}

// Moves a whole group before or after another group (the target's tabs), keeping its order.
// Same index arithmetic as dropping a group block in the strip.
async function moveGroupBeside(dragged, targetTabs, before) {
  if (targetTabs.length === 0) return;
  const targetFirst = Math.min(...targetTabs.map(t => t.index));
  const targetLast = Math.max(...targetTabs.map(t => t.index));
  const draggedIsLeft = dragged.start < targetFirst;

  let newStart;
  if (before) {
    newStart = draggedIsLeft ? targetFirst - dragged.count : targetFirst;
  } else {
    newStart = draggedIsLeft ? targetLast - dragged.count + 1 : targetLast + 1;
  }
  if (newStart === dragged.start) return;

  await moveTabBlock(dragged.tabIds, dragged.start, newStart);
  const newGroupId = await restoreGroupMembership(dragged.id, dragged.tabIds, {
    title: dragged.title,
    color: dragged.color,
  });
  if (newGroupId !== dragged.id && selectedGroupId === dragged.id) {
    selectedGroupId = newGroupId;
  }
}

// Right-click menu for a group block in the strip
function showGroupMenu(x, y, item) {
  closeGroupMenu();

  const menu = document.createElement("div");
  menu.id = "group-context-menu";
  menu.className = "context-menu";
  // In the strip iframe (short) the menu is shown at the top of the strip
  menu.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
  menu.style.top = MODE === "strip" ? "4px" : `${y}px`;

  const endItem = document.createElement("button");
  endItem.type = "button";
  endItem.textContent = "Move group to the end";
  endItem.addEventListener("click", async () => {
    closeGroupMenu();
    await moveGroupToEnd(item);
    refresh();
  });

  menu.appendChild(endItem);
  document.body.appendChild(menu);
}

function closeGroupMenu() {
  document.getElementById("group-context-menu")?.remove();
}

document.addEventListener("click", closeGroupMenu);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeGroupMenu();
});

// Moves all tabs of a group to the end of the window, keeping their order
async function moveGroupToEnd(item) {
  const tabIds = item.tabs.map(t => t.id);
  const all = await api.tabs.query({ windowId: item.tabs[0].windowId });
  const newStart = all.length - tabIds.length;
  if (newStart === item.first) return;

  await moveTabBlock(tabIds, item.first, newStart);
  await restoreGroupMembership(item.group.id, tabIds, { title: item.group.title, color: item.group.color });
}

// Switch the browser to a specific tab (and its window)
async function goToTab(tab) {
  await api.windows.update(tab.windowId, { focused: true });
  await api.tabs.update(tab.id, { active: true });
}

// Jump to the group's first tab in the browser
async function goToGroup(groupTabs) {
  const first = groupTabs[0];
  if (!first) return;
  await api.windows.update(first.windowId, { focused: true });
  await api.tabs.update(first.id, { active: true });
}

function closeAllMenus() {
  document.querySelectorAll(".menu").forEach(m => { m.hidden = true; });
}

// True if the pointer is in the upper half of a tab row (drop before it)
function isUpperHalf(li, event) {
  const rect = li.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2;
}

function clearDropMarkers() {
  document.querySelectorAll(".drop-before, .drop-after").forEach(el => {
    el.classList.remove("drop-before", "drop-after");
  });
}

// True if the pointer is in the left half of an element (drop before it)
function isLeftHalf(el, event) {
  const rect = el.getBoundingClientRect();
  return event.clientX < rect.left + rect.width / 2;
}

// Strip: all tabs of the window in order. Ungrouped tabs are single items,
// each group is one block. Dragging a group block moves all its tabs together.

// Build window-ordered items from tabs (already sorted by index)
function buildWindowItems(tabs, groups) {
  const groupById = new Map(groups.map(g => [g.id, g]));
  const items = [];
  const seen = new Set();

  for (const tab of tabs) {
    if (tab.groupId === TAB_GROUP_ID_NONE) {
      items.push({ kind: "tab", tab, first: tab.index, last: tab.index });
    } else if (!seen.has(tab.groupId)) {
      seen.add(tab.groupId);
      const groupTabs = tabs.filter(t => t.groupId === tab.groupId);
      items.push({
        kind: "group",
        group: groupById.get(tab.groupId),
        tabs: groupTabs,
        first: groupTabs[0].index,
        last: groupTabs[groupTabs.length - 1].index
      });
    }
  }
  return items;
}

// Tell the page while a tab or group is dragged in the strip, so that the drag does not
// count as a click outside the panel (which would close it)
const stripEl = document.getElementById("strip");
stripEl.addEventListener("dragstart", () => sendToEmbedder({ type: "mtg-drag", on: true }));
stripEl.addEventListener("dragend", () => sendToEmbedder({ type: "mtg-drag", on: false }));

// Title label shown while the pointer is over a tab in the strip
stripEl.addEventListener("scroll", postStripTitles);

// The tab under the pointer: its title on the web page gets a yellow background
let lastTitleHoverId = null;
function setTitleHover(tabId) {
  if (tabId === lastTitleHoverId) return;
  lastTitleHoverId = tabId;
  sendToEmbedder({ type: "mtg-title-hover", tabId });
}
stripEl.addEventListener("mouseover", (event) => {
  setTitleHover(event.target.closest(".mini-tab")?.dataset.tabId ?? null);
});
stripEl.addEventListener("mouseleave", () => setTitleHover(null));
window.addEventListener("resize", postStripTitles);

// Mouse wheel scrolls the strip sideways (it is a horizontal row)
document.getElementById("strip").addEventListener("wheel", (event) => {
  const strip = event.currentTarget;
  if (strip.scrollWidth <= strip.clientWidth) return; // nothing to scroll
  event.preventDefault();
  strip.scrollLeft += event.deltaX + event.deltaY;
}, { passive: false });

// Selection actions bar
document.querySelectorAll("#selection-bar button[data-action]").forEach((button) => {
  button.addEventListener("click", () => openSelectionDialog(button.dataset.action));
});

// Scrolls the strip so the browser's active tab is at its horizontal center
function centerActiveTab() {
  const active = lastData?.tabs.find(t => t.active);
  if (!active) return;
  const miniTab = document.querySelector(`#strip [data-tab-id="${active.id}"]`);
  if (!miniTab) return;

  const strip = document.getElementById("strip");
  const box = miniTab.getBoundingClientRect();
  const row = strip.getBoundingClientRect();
  strip.scrollLeft += (box.left + box.width / 2) - (row.left + strip.clientWidth / 2);
}
document.getElementById("center-active").addEventListener("click", centerActiveTab);

// Filter: shows only tabs (and groups with such tabs) whose title or URL contains the text
document.getElementById("strip-filter").addEventListener("input", (event) => {
  stripFilter = event.target.value.trim().toLowerCase();
  if (lastData) renderStrip(lastData);
});

// "<" / ">" scroll the strip by one visible page of tabs.
// With Shift held they go to the first / last tab instead.
// "<" and ">" scroll the strip by one page (Shift: to its start or end). The buttons at the ends of
// the bar and the ones beside the tools row do the same.
function scrollStripBack(event) {
  const strip = document.getElementById("strip");
  strip.scrollLeft = event.shiftKey ? 0 : strip.scrollLeft - strip.clientWidth;
}
function scrollStripForward(event) {
  const strip = document.getElementById("strip");
  strip.scrollLeft = event.shiftKey ? strip.scrollWidth : strip.scrollLeft + strip.clientWidth;
}
for (const id of ["strip-first", "tools-first"]) {
  document.getElementById(id).addEventListener("click", scrollStripBack);
}
for (const id of ["strip-last", "tools-last"]) {
  document.getElementById(id).addEventListener("click", scrollStripForward);
}
// "|<" and ">|" jump to the start and the end of the strip
document.getElementById("tools-start").addEventListener("click", () => {
  document.getElementById("strip").scrollLeft = 0;
});
document.getElementById("tools-end").addEventListener("click", () => {
  const strip = document.getElementById("strip");
  strip.scrollLeft = strip.scrollWidth;
});

// Rebuilding the strip replaces its elements. If that happens between a mouse press and
// release, the click is lost. So the strip is rebuilt only when its content changes.
let lastStripKey = null;

function tabMatchesFilter(tab) {
  if (!stripFilter) return true;
  return `${tab.title || ""} ${tab.url || ""}`.toLowerCase().includes(stripFilter);
}

// With a filter, a group keeps only its matching tabs for display (visibleTabs).
// Moves still use all of the group's tabs (tabs), and indices are the real window ones.
function applyStripFilter(item) {
  if (item.kind === "tab") return tabMatchesFilter(item.tab) ? item : null;
  const visibleTabs = item.tabs.filter(tabMatchesFilter);
  return visibleTabs.length > 0 ? { ...item, visibleTabs } : null;
}

function stripItemKey(item) {
  if (item.kind === "tab") {
    const t = item.tab;
    return ["t", t.id, t.index, t.title, t.favIconUrl, t.url];
  }
  return ["g", item.group.id, item.group.title, item.group.color, item.first, item.last,
    (item.visibleTabs ?? item.tabs).map(t => [t.id, t.title, t.favIconUrl])];
}

function renderStrip(data) {
  const items = buildWindowItems(data.tabs, data.groups)
    .map(applyStripFilter)
    .filter(Boolean);
  const key = JSON.stringify([stripActiveGroupId, stripFilter, items.map(stripItemKey)]);
  if (key === lastStripKey && !scrollStripToActive) return;
  lastStripKey = key;

  const strip = document.getElementById("strip");
  strip.textContent = "";
  for (const item of items) {
    strip.appendChild(item.kind === "tab" ? renderMiniTab(item) : renderMiniGroup(item));
  }
  postStripTitles();

  // Bring the active group fully into view, scrolling the strip if needed (only when it changed,
  // so manual scrolling is not undone on every refresh)
  if (scrollStripToActive) {
    scrollStripToActive = false;
    const active = strip.querySelector(".mini-group.active");
    if (active) {
      const box = active.getBoundingClientRect();
      const row = strip.getBoundingClientRect();
      const margin = 8;
      if (box.left < row.left) strip.scrollLeft += box.left - row.left - margin;
      else if (box.right > row.right) strip.scrollLeft += box.right - row.right + margin;
    }
  }
}

function renderMiniTab(item) {
  const el = createMiniTab(item.tab);
  // A single click opens the tab. Dragging (press and move) does not fire a click.
  el.addEventListener("click", () => goToTab(item.tab));

  // Press and drag an ungrouped tab to move it along the strip
  el.draggable = true;
  el.addEventListener("dragstart", (event) => {
    draggedStripTab = { id: item.tab.id, index: item.tab.index };
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(item.tab.id)); // Firefox needs data to start a drag
    el.classList.add("dragging");
  });
  el.addEventListener("dragend", () => {
    draggedStripTab = null;
    clearDropMarkers();
    el.classList.remove("dragging");
  });

  attachStripDropTarget(el, item);
  return el;
}

// Messages to the page that embeds this view (see content.js). No-op on the manager tab.
function sendToEmbedder(message) {
  if (window.parent !== window) window.parent.postMessage(message, "*");
}

// Strip mode: send the page each visible tab's x position and title, so content.js can draw the
// titles above the strip, on the web page. Nothing is sent while the strip is compact.
function postStripTitles() {
  if (MODE !== "strip") return;
  const strip = document.getElementById("strip");
  const items = [];
  if (!document.body.classList.contains("compact")) {
    const frame = strip.getBoundingClientRect();
    for (const el of strip.querySelectorAll(".mini-tab")) {
      const r = el.getBoundingClientRect();
      if (r.right <= frame.left || r.left >= frame.right) continue; // scrolled out of view
      items.push({ id: el.dataset.tabId, x: r.left + 4, title: el.dataset.title });
    }
  }
  sendToEmbedder({ type: "mtg-titles", items });
}

// The "×" button on a tab or group in the strip. Its clicks do not reach the tab or group under it.
function makeCloseButton(title, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mini-close";
  button.textContent = "×";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  button.addEventListener("dblclick", (event) => event.stopPropagation());
  return button;
}

// A miniature tab showing the page icon (falls back to a plain box if none)
function createMiniTab(tab) {
  const el = document.createElement("div");
  el.className = "mini-tab";
  el.dataset.title = tab.title || tab.url; // shown by the strip's title label, not a native tooltip
  el.dataset.tabId = String(tab.id);       // used by "center the active tab"

  if (tab.favIconUrl) {
    const icon = document.createElement("img");
    icon.className = "mini-favicon";
    icon.alt = "";
    icon.src = tab.favIconUrl;
    icon.addEventListener("error", () => icon.remove()); // broken icon: keep the plain box
    el.appendChild(icon);
  }
  el.appendChild(makeCloseButton("Close tab", async () => {
    await api.tabs.remove(tab.id);
  }));
  return el;
}

function renderMiniGroup(item) {
  const el = document.createElement("div");
  el.className = "mini-group";
  if (item.group.id === stripActiveGroupId) el.classList.add("active");
  el.style.borderColor = item.group.color;
  el.draggable = true;
  el.title = "Drag to move the whole group";

  const label = document.createElement("span");
  label.className = "mini-group-label";
  label.textContent = item.group.title || `Group ${item.group.id}`;

  const tabsRow = document.createElement("div");
  tabsRow.className = "mini-group-tabs";
  for (const tab of item.visibleTabs ?? item.tabs) {
    const mini = createMiniTab(tab);
    // Double-click a tab inside the block goes to that tab, not to the group's first tab
    mini.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      goToTab(tab);
    });
    tabsRow.appendChild(mini);
  }

  // Closing a group ungroups its tabs: they stay open as individual tabs
  const close = makeCloseButton("Close group (its tabs stay open, ungrouped)", async () => {
    await api.tabs.ungroup(item.tabs.map(t => t.id));
    refresh();
  });
  el.append(label, tabsRow, close);

  el.addEventListener("dblclick", () => goToGroup(item.tabs));
  el.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    showGroupMenu(event.clientX, event.clientY, item);
  });

  el.addEventListener("click", () => {
    if (MODE === "strip") {
      sendToEmbedder({ type: "mtg-open", groupId: item.group.id });
    } else if (selectedGroupId !== item.group.id) {
      selectGroup(item.group.id);
    }
  });

  el.addEventListener("dragstart", (event) => {
    draggedGroup = {
      id: item.group.id,
      title: item.group.title,
      color: item.group.color,
      tabIds: item.tabs.map(t => t.id),
      start: item.first,
      count: item.tabs.length
    };
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(item.group.id)); // Firefox needs data to start a drag
    el.classList.add("dragging");
  });
  el.addEventListener("dragend", () => {
    draggedGroup = null;
    clearDropMarkers();
    el.classList.remove("dragging");
  });

  attachStripDropTarget(el, item);
  return el;
}

// Drop a dragged group block before or after this strip item
function attachStripDropTarget(el, item) {
  // A drag is either a group block or an ungrouped tab
  const dragging = () => draggedGroup || draggedStripTab;
  const isSelf = () =>
    (item.kind === "group" && draggedGroup && item.group.id === draggedGroup.id) ||
    (item.kind === "tab" && draggedStripTab && item.tab.id === draggedStripTab.id);

  el.addEventListener("dragover", (event) => {
    if (!dragging() || isSelf()) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    clearDropMarkers();
    el.classList.add(isLeftHalf(el, event) ? "drop-before" : "drop-after");
  });

  el.addEventListener("dragleave", () => {
    el.classList.remove("drop-before", "drop-after");
  });

  el.addEventListener("drop", async (event) => {
    event.preventDefault();
    if (!dragging() || isSelf()) return;

    const before = isLeftHalf(el, event);

    if (draggedStripTab) {
      // A single ungrouped tab goes just before or after this item, outside any group
      const { id, index: from } = draggedStripTab;
      draggedStripTab = null;
      const draggedIsLeft = from < item.first;
      let newStart;
      if (before) {
        newStart = draggedIsLeft ? item.first - 1 : item.first;
      } else {
        newStart = draggedIsLeft ? item.last : item.last + 1;
      }
      if (newStart !== from) {
        await api.tabs.move(id, { index: newStart });
      }
      refresh();
      return;
    }

    const { id: groupId, title, color, tabIds, start, count } = draggedGroup;
    draggedGroup = null;

    // tabs.move uses final window indices. Dragged block sits left of the
    // target when start < item.first, which shifts the target by `count`.
    const draggedIsLeft = start < item.first;
    let newStart;
    if (before) {
      newStart = draggedIsLeft ? item.first - count : item.first;
    } else {
      newStart = draggedIsLeft ? item.last - count + 1 : item.last + 1;
    }

    if (newStart !== start) {
      await moveTabBlock(tabIds, start, newStart);
      const newGroupId = await restoreGroupMembership(groupId, tabIds, { title, color });
      if (newGroupId !== groupId && selectedGroupId === groupId) {
        selectedGroupId = newGroupId;
      }
    }
    refresh();
  });
}

// Close any open menu when clicking elsewhere
document.addEventListener("click", closeAllMenus);

// Dialogs (overlay + dialog box) ------------------------------------------

function closeDialogs() {
  document.body.classList.remove("picker-open");
  if (panelActions) {
    panelActions.style.opacity = "";
    panelActions.style.pointerEvents = "";
  }
  document.getElementById("tab-picker")?.remove();
  document.getElementById("rename-dialog")?.remove();
  document.getElementById("selection-dialog")?.remove();
}

function createOverlay(id) {
  const overlay = document.createElement("div");
  overlay.id = id;
  overlay.className = "overlay";
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeDialogs();
  });
  return overlay;
}

// Rename dialog ----------------------------------------------------------

function openRenameDialog(group) {
  closeDialogs();
  const overlay = createOverlay("rename-dialog");

  const dialog = document.createElement("div");
  dialog.className = "dialog";

  const heading = document.createElement("h2");
  heading.textContent = "Rename group";

  const form = document.createElement("form");
  form.className = "dialog-form";

  const input = document.createElement("input");
  input.type = "text";
  input.value = group.title || "";
  input.placeholder = `Group ${group.id}`;

  const actions = document.createElement("div");
  actions.className = "dialog-actions";

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.textContent = "Cancel";
  cancelButton.addEventListener("click", closeDialogs);

  const saveButton = document.createElement("button");
  saveButton.type = "submit";
  saveButton.textContent = "Save";

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await api.tabGroups.update(group.id, { title: input.value.trim() });
    closeDialogs();
    refresh();
  });

  actions.append(cancelButton, saveButton);
  form.append(input, actions);
  dialog.append(heading, form);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  input.focus();
  input.select();
}

// Tab picker: lists tabs that are not in any group, with a filter and a "+" per tab

async function openTabPicker(group) {
  closeDialogs();
  const managerUrl = api.runtime.getURL("manager.html");
  const tabs = (await api.tabs.query({ windowId: group.windowId }))
    .filter(t => t.groupId === TAB_GROUP_ID_NONE && t.url !== managerUrl);

  const overlay = createOverlay("tab-picker");
  document.body.classList.add("picker-open"); // greys out the group's "..." and "×" meanwhile
  if (panelActions) {
    // Inline as well as by class: the panel's "..." and "×" element is stable across refreshes
    panelActions.style.opacity = "0.35";
    panelActions.style.pointerEvents = "none";
  }

  const dialog = document.createElement("div");
  dialog.className = "dialog";

  const heading = document.createElement("h2");
  heading.textContent = `Add tabs to ${group.title || `Group ${group.id}`}`;

  const filter = document.createElement("input");
  filter.type = "search";
  filter.placeholder = "Filter tabs...";

  const list = document.createElement("ul");
  list.className = "picker-list";

  const renderList = () => {
    const query = filter.value.trim().toLowerCase();
    list.textContent = "";

    const matches = tabs.filter(t =>
      !query || `${t.title || ""} ${t.url || ""}`.toLowerCase().includes(query));

    if (matches.length === 0) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = tabs.length === 0 ? "No ungrouped tabs." : "No tabs match the filter.";
      list.appendChild(empty);
      return;
    }

    for (const tab of matches) {
      const li = document.createElement("li");

      const name = document.createElement("span");
      name.className = "title";
      name.textContent = tab.title || tab.url;
      name.title = tab.url;

      const addButton = document.createElement("button");
      addButton.className = "round";
      addButton.textContent = "+";
      addButton.title = "Move this tab to the group";
      addButton.addEventListener("click", async () => {
        await addTabsToGroupEnd([tab.id], group); // the tab goes to the end of the group
        closeDialogs();
        refresh();
      });

      li.append(name, addButton);
      list.appendChild(li);
    }
  };
  filter.addEventListener("input", renderList);

  const closeButton = document.createElement("button");
  closeButton.className = "dialog-close";
  closeButton.textContent = "Close";
  closeButton.addEventListener("click", closeDialogs);

  // Open a new tab (URL, or a web search if the text is not a URL) in this group
  const newTabForm = document.createElement("form");
  newTabForm.className = "new-tab-form";

  const urlInput = document.createElement("input");
  urlInput.type = "text";
  urlInput.placeholder = "URL or search terms";

  const openButton = document.createElement("button");
  openButton.type = "submit";
  openButton.textContent = "Open";

  newTabForm.append(urlInput, openButton);
  newTabForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!urlInput.value.trim()) return;
    await addNewTabToGroup(group, urlInput.value);
    closeDialogs();
    refresh();
  });

  dialog.append(heading, newTabForm, filter, list, closeButton);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  renderList();
  filter.focus();
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDialogs();
});

// Tabs checked in the group lists, for the copy/move actions
const selectedTabIds = new Set();

const ACTION_TITLES = {
  "copy-to-group": "Copy to another group",
  "move-to-group": "Move to another group",
  "copy-to-new": "Copy to a new group",
  "move-to-new": "Move to a new group",
};

// Browser colors are names; these are the CSS colors used to show them
const CSS_COLORS = {
  grey: "#8a8f98", blue: "#3b82f6", red: "#ef4444", yellow: "#eab308", green: "#22c55e",
  pink: "#ec4899", purple: "#a855f7", cyan: "#06b6d4", orange: "#f97316",
};

function updateSelectionBar() {
  const bar = document.getElementById("selection-bar");
  bar.hidden = selectedTabIds.size === 0;
  document.getElementById("selection-count").textContent = `${selectedTabIds.size} selected`;
  if (MODE === "panel") postPanelBounds();
}

function groupLabel(group) {
  return group.title || `Group ${group.id}`;
}

function colorSwatch(color) {
  const swatch = document.createElement("span");
  swatch.className = "swatch";
  swatch.style.background = CSS_COLORS[color] || "#999";
  return swatch;
}

// Copies each tab next to its original; returns the copies' ids in the same order
async function duplicateTabs(tabIds) {
  const copies = [];
  for (const id of tabIds) {
    const copy = await api.tabs.duplicate(id);
    copies.push(copy.id);
  }
  return copies;
}

// Puts the tabs into a new group. Tabs are first gathered at the end of the window
// (contiguous), grouped, and then the group is moved after the current group if asked.
async function placeInNewGroup(tabIds, { title, position, currentGroup }) {
  for (const id of tabIds) {
    await api.tabs.move(id, { index: -1 });
  }

  const newGroupId = await api.tabs.group({ tabIds });
  if (title) await api.tabGroups.update(newGroupId, { title });

  if (position === "after" && currentGroup) {
    const tabs = await api.tabs.query({ windowId: currentGroup.windowId });
    const currentTabs = tabs.filter(t => t.groupId === currentGroup.id);
    if (currentTabs.length > 0) {
      const lastIndex = Math.max(...currentTabs.map(t => t.index));
      const start = tabs.length - tabIds.length; // the block at the end of the window
      if (lastIndex + 1 !== start) {
        await moveTabBlock(tabIds, start, lastIndex + 1);
      }
    }
  }
  return newGroupId;
}

// Adds tabs to the end of an existing group. Tabs are first gathered at the end of the
// window, grouped, and then the block is moved right after the group's last tab.
async function addTabsToGroupEnd(tabIds, group) {
  for (const id of tabIds) {
    await api.tabs.move(id, { index: -1 });
  }
  await api.tabs.group({ tabIds, groupId: group.id });
  await restoreGroupMembership(group.id, tabIds, { title: group.title, color: group.color });

  const all = await api.tabs.query({ windowId: group.windowId });
  const moved = all.filter(t => tabIds.includes(t.id)).sort((a, b) => a.index - b.index);
  const others = all.filter(t => t.groupId === group.id && !tabIds.includes(t.id));
  if (moved.length === 0 || others.length === 0) return;

  const lastIndex = Math.max(...others.map(t => t.index));
  const start = moved[0].index;
  const count = moved.length;
  // Block left of the group's last tab: after removing it, the group shifts left by `count`
  const newStart = start < lastIndex ? lastIndex - count + 1 : lastIndex + 1;
  if (newStart !== start) {
    await moveTabBlock(moved.map(t => t.id), start, newStart);
  }
}

// Dialog for the four selection actions
async function openSelectionDialog(action) {
  const data = await loadData();
  const tabIds = [...selectedTabIds];
  if (tabIds.length === 0) return;

  closeDialogs();
  const overlay = createOverlay("selection-dialog");

  const dialog = document.createElement("div");
  dialog.className = "dialog";

  const heading = document.createElement("h2");
  heading.textContent = ACTION_TITLES[action];

  const form = document.createElement("form");
  form.className = "dialog-form";

  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.textContent = "Cancel";
  cancelButton.addEventListener("click", closeDialogs);
  const okButton = document.createElement("button");
  okButton.type = "submit";
  okButton.textContent = "OK";
  actions.append(cancelButton, okButton);

  const finish = () => {
    selectedTabIds.clear();
    closeDialogs();
    refresh();
  };

  if (action === "copy-to-group" || action === "move-to-group") {
    // Existing group, shown with its color
    const row = document.createElement("div");
    row.className = "dialog-row";

    const select = document.createElement("select");
    for (const group of data.groups) {
      const option = document.createElement("option");
      option.value = String(group.id);
      option.textContent = groupLabel(group);
      select.appendChild(option);
    }

    let swatch = colorSwatch(data.groups[0]?.color);
    const showColor = () => {
      const group = data.groups.find(g => String(g.id) === select.value);
      const next = colorSwatch(group?.color);
      swatch.replaceWith(next);
      swatch = next;
    };
    select.addEventListener("change", showColor);

    row.append(swatch, select);
    form.append(row);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const groupId = Number(select.value);
      const ids = action === "copy-to-group" ? await duplicateTabs(tabIds) : tabIds;
      await addTabsToGroupEnd(ids, data.groups.find(g => g.id === groupId));
      finish();
    });
  } else {
    // New group: name, and where to place it
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "Group name";

    const placeRow = document.createElement("div");
    placeRow.className = "dialog-row";
    const placeLabel = document.createElement("span");
    placeLabel.textContent = "Place a new group:";

    const placeSelect = document.createElement("select");
    const currentGroup = data.groups.find(g => g.id === selectedGroupId) || null;
    if (currentGroup) {
      const after = document.createElement("option");
      after.value = "after";
      after.textContent = "after this group";
      placeSelect.appendChild(after);
    }
    const atEnd = document.createElement("option");
    atEnd.value = "end";
    atEnd.textContent = "at the end";
    placeSelect.appendChild(atEnd);

    placeRow.append(placeLabel, placeSelect);
    form.append(nameInput, placeRow);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const ids = action === "copy-to-new" ? await duplicateTabs(tabIds) : tabIds;
      await placeInNewGroup(ids, {
        title: nameInput.value.trim(),
        position: placeSelect.value,
        currentGroup,
      });
      finish();
    });
    setTimeout(() => nameInput.focus(), 0);
  }

  form.append(actions);
  dialog.append(heading, form);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
}

async function refresh() {
  render(await loadData());
}

// Extension APIs. On a web page, the strip and panel iframes cannot reach them directly,
// so they go through content.js and the background script (see createRemoteApi).
// Declared after the remote tables below, which createRemoteApi reads.
const REMOTE_CALLS = {
  tabs: ["query", "get", "move", "group", "ungroup", "update", "create", "duplicate", "remove"],
  tabGroups: ["query", "get", "update"],
  windows: ["getCurrent", "update"],
  search: ["search"],
};

const REMOTE_EVENTS = {
  tabs: ["onCreated", "onRemoved", "onUpdated", "onMoved", "onAttached", "onDetached", "onActivated"],
  tabGroups: ["onCreated", "onUpdated", "onRemoved", "onMoved"],
};

const api = MODE === "page" ? browser : createRemoteApi();

function createRemoteApi() {
  let nextId = 1;
  const pending = new Map();   // call id -> { resolve, reject }
  const listeners = new Map(); // "tabs.onCreated" -> Set of callbacks

  for (const [ns, events] of Object.entries(REMOTE_EVENTS)) {
    for (const ev of events) listeners.set(`${ns}.${ev}`, new Set());
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || !event.data) return;

    if (event.data.type === "mtg-rpc-result") {
      const call = pending.get(event.data.id);
      if (!call) return;
      pending.delete(event.data.id);
      if (event.data.ok) call.resolve(event.data.result);
      else call.reject(new Error(event.data.error));
    } else if (event.data.type === "mtg-event") {
      for (const name of event.data.names || []) {
        listeners.get(name)?.forEach(callback => callback());
      }
    }
  });

  function call(path, args) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      window.parent.postMessage({ type: "mtg-rpc", id, path, args }, "*");
    });
  }

  const remote = {
    runtime: { getURL: (path) => new URL(path, location.href).href },
  };

  for (const [ns, methods] of Object.entries(REMOTE_CALLS)) {
    remote[ns] = {};
    for (const method of methods) {
      remote[ns][method] = (...args) => call(`${ns}.${method}`, args);
    }
  }

  for (const [ns, events] of Object.entries(REMOTE_EVENTS)) {
    remote[ns] = remote[ns] || {};
    for (const ev of events) {
      remote[ns][ev] = { addListener: (callback) => listeners.get(`${ns}.${ev}`).add(callback) };
    }
  }

  return remote;
}

// Strip mode: icons-only layout when the page's panel was closed by a click outside it
if (MODE === "strip") {
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    if (event.data?.type === "mtg-compact") {
      document.body.classList.toggle("compact", Boolean(event.data.on));
      postStripTitles();
    } else if (event.data?.type === "mtg-active") {
      const next = event.data.groupId ?? null;
      // Scroll only when the active group actually changes; this message repeats on every refresh
      if (next !== stripActiveGroupId) {
        stripActiveGroupId = next;
        scrollStripToActive = true;
      }
      if (lastData) renderStrip(lastData);
    }
  });
}

// Panel mode: tell the page how far down the title and the groups go, so the panel's
// iframe covers exactly that. Nothing is measured while the panel is hidden.
function postPanelBounds() {
  if (!window.innerWidth) return; // hidden iframe: no layout to measure
  const boxes = [document.querySelector("header"), ...document.querySelectorAll("#groups .group")]
    .filter(Boolean)
    .map(el => el.getBoundingClientRect().bottom);
  sendToEmbedder({
    type: "mtg-bounds",
    height: Math.max(0, ...boxes) + 56 // 56px spare so nothing is cut off at the bottom
  });
}

// Builds the "..." and "×" group in the panel
function buildPanelActions() {
  const actions = document.createElement("div");
  actions.className = "panel-actions";

  const more = document.createElement("div");
  more.className = "panel-more";

  const moreButton = document.createElement("button");
  moreButton.type = "button";
  moreButton.className = "panel-more-button";
  moreButton.textContent = "...";
  moreButton.title = "More actions";

  const menu = document.createElement("div");
  menu.className = "menu";
  menu.hidden = true;
  menu.addEventListener("click", (event) => event.stopPropagation());

  const ungroupItem = document.createElement("button");
  ungroupItem.type = "button";
  ungroupItem.textContent = "Ungroup tabs";
  ungroupItem.addEventListener("click", async () => {
    closeAllMenus();
    await ungroupSelectedGroup();
  });
  menu.appendChild(ungroupItem);

  moreButton.addEventListener("click", (event) => {
    event.stopPropagation();
    const wasHidden = menu.hidden;
    closeAllMenus();
    menu.hidden = !wasHidden;
  });

  more.append(moreButton, menu);
  actions.append(more, closeButton);
  return actions;
}

// Ungroups every tab of the active group. The group disappears; the next group is selected.
async function ungroupSelectedGroup() {
  const tabIds = (lastData?.tabs || [])
    .filter(t => t.groupId === selectedGroupId)
    .map(t => t.id);
  if (tabIds.length > 0) {
    await api.tabs.ungroup(tabIds);
  }
  selectedGroupId = null;
  refresh();
}

// Panel mode: minimize button and selection requests from the embedding page
if (MODE === "panel") {
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    if (event.data?.type === "mtg-measure") postPanelBounds();
    if (event.data?.type === "mtg-select" && event.data.groupId != null) {
      selectGroup(event.data.groupId);
    }
  });

  // closeButton is moved into panelActions, so it is not found by id any more
  closeButton.addEventListener("click", () => {
    sendToEmbedder({ type: "mtg-close" });
  });

  sendToEmbedder({ type: "mtg-ready" });
}

// Refresh on browser-side changes
const refreshEvents = [
  api.tabs.onCreated, api.tabs.onRemoved, api.tabs.onUpdated,
  api.tabs.onMoved, api.tabs.onAttached, api.tabs.onDetached,
  api.tabs.onActivated,
  api.tabGroups.onCreated, api.tabGroups.onUpdated, api.tabGroups.onRemoved,
  api.tabGroups.onMoved
];
for (const event of refreshEvents) {
  event.addListener(refresh);
}


refresh();

// Setting: titles above the bottom strip on web pages. Stored in browser.storage.local; content.js follows it.
const showTitlesBox = document.getElementById("show-titles");
browser.storage.local.get({ showStripTitles: true }).then((settings) => {
  showTitlesBox.checked = settings.showStripTitles;
}).catch(() => {});
showTitlesBox.addEventListener("change", () => {
  browser.storage.local.set({ showStripTitles: showTitlesBox.checked }).catch(() => {});
});
