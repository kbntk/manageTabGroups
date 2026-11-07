// Injected into web pages. Shows the tab group strip at the bottom of the page,
// the panel above it (an iframe of manager.html?mode=panel), and a minimized bar.
// The strip is an iframe of manager.html?mode=strip. Iframes talk to this script
// with postMessage; messages are accepted only from our own extension origin.
(() => {
  const EXT_ORIGIN = new URL(browser.runtime.getURL("")).origin;
  const STRIP_HEIGHT = 80;   // px, expanded strip
  const STRIP_COLLAPSED = 8; // px, minimized state without hover
  const BAR_COLLAPSED = 8;   // px, minimized bar without hover
  const BAR_EXPANDED = 28;   // px, minimized bar on hover

  const state = {
    open: false,      // panel visible
    minimized: false, // panel minimized to the bar
    hoverStrip: false,
    hoverBar: false,
  };

  let panel = null;
  let panelReady = false;
  let pendingSelect = null; // group to select once the panel has loaded
  let minimizedGroupId = null;

  function style(el, props) {
    Object.assign(el.style, props);
    return el;
  }

  // Bottom strip
  const strip = style(document.createElement("iframe"), {
    position: "fixed",
    left: "0",
    right: "0",
    bottom: "0",
    width: "100%",
    height: `${STRIP_HEIGHT}px`,
    border: "0",
    zIndex: "999",
    background: "#fafafa",
  });
  strip.src = browser.runtime.getURL("manager.html?mode=strip");
  strip.addEventListener("mouseenter", () => { state.hoverStrip = true; layout(); });
  strip.addEventListener("mouseleave", () => { state.hoverStrip = false; layout(); });

  // Minimized bar with the group name, top right
  const bar = style(document.createElement("div"), {
    position: "fixed",
    top: "0",
    right: "0",
    maxWidth: "50%",
    minWidth: "160px",
    padding: "0 8px",
    boxSizing: "border-box",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    font: "12px system-ui, sans-serif",
    color: "#fff",
    background: "#111",
    cursor: "pointer",
    zIndex: "1000",
    display: "none",
  });
  bar.addEventListener("mouseenter", () => { state.hoverBar = true; layout(); });
  bar.addEventListener("mouseleave", () => { state.hoverBar = false; layout(); });
  bar.addEventListener("click", () => openPanel(minimizedGroupId));

  // Panel above the strip
  function createPanel() {
    const frame = style(document.createElement("iframe"), {
      position: "fixed",
      top: "0",
      left: "0",
      width: "100%",
      height: "0px", // set to the height of the groups area by the panel ("mtg-bounds")
      border: "0",
      background: "transparent",
      zIndex: "1000",
      display: "none",
    });
    frame.src = browser.runtime.getURL("manager.html?mode=panel");
    document.documentElement.appendChild(frame);
    return frame;
  }

  function selectInPanel(groupId) {
    if (panelReady) {
      panel.contentWindow.postMessage({ type: "mtg-select", groupId }, EXT_ORIGIN);
    } else {
      pendingSelect = groupId;
    }
  }

  function openPanel(groupId) {
    state.open = true;
    state.minimized = false;
    if (!panel) panel = createPanel();
    panel.style.display = "block";
    if (groupId != null) selectInPanel(groupId);
    layout();
  }

  function minimizePanel(groupId, title) {
    state.open = false;
    state.minimized = true;
    minimizedGroupId = groupId;
    if (panel) panel.style.display = "none";
    bar.textContent = title || "Group";
    layout();
  }

  // Strip and bar sizes depend on the state and hover
  function layout() {
    const stripCollapsed = state.minimized && !state.hoverStrip;
    strip.style.height = `${stripCollapsed ? STRIP_COLLAPSED : STRIP_HEIGHT}px`;

    bar.style.display = state.minimized ? "block" : "none";
    const barHeight = state.hoverBar ? BAR_EXPANDED : BAR_COLLAPSED;
    bar.style.height = `${barHeight}px`;
    bar.style.lineHeight = `${barHeight}px`;
  }

  // Extension API calls from the strip or panel: relay to the background script
  async function relayRpc(event) {
    const { id, path, args } = event.data;
    let reply;
    try {
      const result = await browser.runtime.sendMessage({ type: "mtg-rpc", path, args });
      reply = { ok: true, result };
    } catch (error) {
      reply = { ok: false, error: String(error) };
    }
    event.source.postMessage({ type: "mtg-rpc-result", id, ...reply }, EXT_ORIGIN);
  }

  window.addEventListener("message", (event) => {
    if (event.origin !== EXT_ORIGIN || !event.data) return;
    if (event.data.type === "mtg-rpc") {
      relayRpc(event);
      return;
    }
    const { type, groupId, title } = event.data;

    if (type === "mtg-bounds" && panel && event.source === panel.contentWindow) {
      // Only the groups area is the panel: the rest stays transparent and clickable
      panel.style.height = `${Math.max(0, Math.ceil(event.data.height))}px`;
    } else if (type === "mtg-open") {
      openPanel(groupId ?? null);
    } else if (type === "mtg-minimize") {
      minimizePanel(groupId ?? null, title);
    } else if (type === "mtg-ready" && panel && event.source === panel.contentWindow) {
      panelReady = true;
      if (pendingSelect != null) {
        selectInPanel(pendingSelect);
        pendingSelect = null;
      }
    }
  });

  // Change notifications from the background script, forwarded to the strip and panel
  browser.runtime.onMessage.addListener((message) => {
    if (message?.type !== "mtg-event") return;
    for (const frame of [strip, panel]) {
      frame?.contentWindow?.postMessage({ type: "mtg-event", names: message.names }, EXT_ORIGIN);
    }
  });

  document.documentElement.append(strip, bar);
  layout();
})();
