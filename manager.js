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

const COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
const TAB_GROUP_ID_NONE = -1; // browser.tabGroups.TAB_GROUP_ID_NONE

let selectedGroupId = null;
let scrollToSelected = false; // set when the selection changes, so the active group is centered
let draggedTab = null; // { id, index, groupId } while a tab row is being dragged
let draggedGroup = null; // { id, tabIds, start, count } while a group block is dragged in the strip

async function loadData() {
  const win = await api.windows.getCurrent();
  const groups = await api.tabGroups.query({ windowId: win.id });
  const tabs = await api.tabs.query({ windowId: win.id });
  const activeTab = tabs.find(t => t.active);
  return { windowId: win.id, groups, tabs, activeTab };
}

function render(data) {
  const { groups, tabs } = data;
  if (selectedGroupId === null && groups.length > 0) {
    selectedGroupId = groups[0].id;
    scrollToSelected = true;
  }

  renderNav(groups);

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

  if (MODE === "panel") postPanelBounds();

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
    // Double-click a tab row of the active group to switch to that tab
    if (group.id === selectedGroupId) {
      li.addEventListener("dblclick", (event) => {
        if (event.target.closest("button")) return;
        event.preventDefault(); // no text selection from the double-click
        goToTab(tab);
      });
    }

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

    li.append(name, tabMenuWrap);
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

function renderStrip(data) {
  const strip = document.getElementById("strip");
  strip.textContent = "";
  for (const item of buildWindowItems(data.tabs, data.groups)) {
    strip.appendChild(item.kind === "tab" ? renderMiniTab(item) : renderMiniGroup(item));
  }
}

function renderMiniTab(item) {
  const el = createMiniTab(item.tab);
  el.addEventListener("click", () => {
    if (MODE === "strip") sendToEmbedder({ type: "mtg-open", groupId: null });
  });
  el.addEventListener("dblclick", () => goToTab(item.tab));
  attachStripDropTarget(el, item);
  return el;
}

// Messages to the page that embeds this view (see content.js). No-op on the manager tab.
function sendToEmbedder(message) {
  if (window.parent !== window) window.parent.postMessage(message, "*");
}

// A miniature tab showing the page icon (falls back to a plain box if none)
function createMiniTab(tab) {
  const el = document.createElement("div");
  el.className = "mini-tab";
  el.title = tab.title || tab.url;

  if (tab.favIconUrl) {
    const icon = document.createElement("img");
    icon.className = "mini-favicon";
    icon.alt = "";
    icon.src = tab.favIconUrl;
    icon.addEventListener("error", () => icon.remove()); // broken icon: keep the plain box
    el.appendChild(icon);
  }
  return el;
}

function renderMiniGroup(item) {
  const el = document.createElement("div");
  el.className = "mini-group";
  el.style.borderColor = item.group.color;
  el.draggable = true;
  el.title = "Drag to move the whole group";

  const label = document.createElement("span");
  label.className = "mini-group-label";
  label.textContent = item.group.title || `Group ${item.group.id}`;

  const tabsRow = document.createElement("div");
  tabsRow.className = "mini-group-tabs";
  for (const tab of item.tabs) {
    const mini = createMiniTab(tab);
    // Double-click a tab inside the block goes to that tab, not to the group's first tab
    mini.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      goToTab(tab);
    });
    tabsRow.appendChild(mini);
  }

  el.append(label, tabsRow);

  el.addEventListener("dblclick", () => goToGroup(item.tabs));

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
  const isSelf = () => item.kind === "group" && draggedGroup && item.group.id === draggedGroup.id;

  el.addEventListener("dragover", (event) => {
    if (!draggedGroup || isSelf()) return;
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
    if (!draggedGroup || isSelf()) return;

    const before = isLeftHalf(el, event);
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
  document.getElementById("tab-picker")?.remove();
  document.getElementById("rename-dialog")?.remove();
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
        await api.tabs.group({ tabIds: [tab.id], groupId: group.id });
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

async function refresh() {
  render(await loadData());
}

// Extension APIs. On a web page, the strip and panel iframes cannot reach them directly,
// so they go through content.js and the background script (see createRemoteApi).
// Declared after the remote tables below, which createRemoteApi reads.
const REMOTE_CALLS = {
  tabs: ["query", "get", "move", "group", "ungroup", "update", "create"],
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

// Panel mode: minimize button and selection requests from the embedding page
if (MODE === "panel") {
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    if (event.data?.type === "mtg-measure") postPanelBounds();
    if (event.data?.type === "mtg-select" && event.data.groupId != null) {
      selectGroup(event.data.groupId);
    }
  });

  document.getElementById("minimize").addEventListener("click", () => {
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
