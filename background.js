// Clicking the extension icon opens (or focuses) the tab group manager page.
browser.action.onClicked.addListener(async () => {
  const url = browser.runtime.getURL("manager.html");
  const existing = await browser.tabs.query({ url });
  if (existing.length > 0) {
    await browser.tabs.update(existing[0].id, { active: true });
    await browser.windows.update(existing[0].windowId, { focused: true });
  } else {
    await browser.tabs.create({ url });
  }
});

// Calls from the strip and panel (iframes on web pages) to extension APIs that
// those frames cannot reach. content.js relays them here. Only these are allowed.
const ALLOWED_CALLS = new Set([
  "tabs.query", "tabs.get", "tabs.move", "tabs.group", "tabs.ungroup", "tabs.update", "tabs.create",
  "tabGroups.query", "tabGroups.get", "tabGroups.update",
  "windows.getCurrent", "windows.update",
  "search.search",
]);

browser.runtime.onMessage.addListener(async (message, sender) => {
  if (message?.type !== "mtg-rpc" || !sender.tab) return undefined;

  const { path, args = [] } = message;
  if (!ALLOWED_CALLS.has(path)) throw new Error(`Call not allowed: ${path}`);

  // The caller is a web page's strip or panel: "current window" means the sender's window
  if (path === "windows.getCurrent") {
    return browser.windows.get(sender.tab.windowId);
  }

  const [namespace, method] = path.split(".");
  return browser[namespace][method](...args);
});

// Change notifications: tell the content scripts (and so the strip and panel)
// that tabs or groups changed. Batched so bursts of events send one message.
const EVENT_NAMES = [
  "tabs.onCreated", "tabs.onRemoved", "tabs.onUpdated", "tabs.onMoved",
  "tabs.onAttached", "tabs.onDetached", "tabs.onActivated",
  "tabGroups.onCreated", "tabGroups.onUpdated", "tabGroups.onRemoved", "tabGroups.onMoved",
];

let pendingEvents = new Set();
let flushTimer = null;

function queueEvent(name) {
  pendingEvents.add(name);
  if (flushTimer === null) flushTimer = setTimeout(flushEvents, 150);
}

async function flushEvents() {
  flushTimer = null;
  const names = [...pendingEvents];
  pendingEvents = new Set();

  const tabs = await browser.tabs.query({ url: ["http://*/*", "https://*/*"] });
  for (const tab of tabs) {
    // Tabs without our content script (e.g. opened before the extension loaded) reject; ignore them
    browser.tabs.sendMessage(tab.id, { type: "mtg-event", names }).catch(() => {});
  }
}

for (const name of EVENT_NAMES) {
  const [namespace, event] = name.split(".");
  browser[namespace][event].addListener(() => queueEvent(name));
}
