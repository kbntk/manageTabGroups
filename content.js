// Injected into web pages. Shows the tab group strip at the bottom of the page,
// the panel above it (an iframe of manager.html?mode=panel), and a minimized bar.
// The strip is an iframe of manager.html?mode=strip. Iframes talk to this script
// with postMessage; messages are accepted only from our own extension origin.
(() => {
  const EXT_ORIGIN = new URL(browser.runtime.getURL("")).origin;
  const STRIP_HEIGHT = 80;   // px, expanded strip
  // Highest z-index a page can use. Sites such as bbc.com have sticky menus with z-index
  // above 1000, which covered the panel's title; the panel must stay on top of them.
  const TOP_Z_INDEX = "2147483647";
  const STRIP_COLLAPSED = 8; // px, minimized state without hover
  const STRIP_COMPACT = 26;  // px, strip with icons only, after a click outside the panel
  const BAR_COLLAPSED = 8;   // px, minimized bar without hover
  const BAR_EXPANDED = 28;   // px, minimized bar on hover

  const state = {
    open: false,      // panel visible
    minimized: false, // panel minimized to the bar
    compact: true,    // strip shows icons only (default; cleared when the panel opens)
    hoverStrip: false,
    hoverBar: false,
  };

  let panel = null;
  let panelReady = false;
  let pendingSelect = null; // group to select once the panel has loaded
  let minimizedGroupId = null;
  let dragging = false;        // a tab or group is being dragged in the strip
  let ignoreClicksUntil = 0;   // a click right after a drag is not a click outside

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
  strip.addEventListener("load", () => { postCompact(); postActive(); });

  // Group that is active in the open panel; the strip highlights it
  let activeGroupId = null;
  function postActive() {
    strip.contentWindow?.postMessage(
      { type: "mtg-active", groupId: state.open ? activeGroupId : null },
      EXT_ORIGIN
    );
  }

  // Icons-only mode lasts until the pointer is over the strip; hovering shows the full strip
  function isCompact() {
    return state.compact && !state.hoverStrip;
  }

  // Tell the strip whether to show icons only
  function postCompact() {
    strip.contentWindow?.postMessage({ type: "mtg-compact", on: isCompact() }, EXT_ORIGIN);
  }

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
    zIndex: TOP_Z_INDEX,
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
      zIndex: TOP_Z_INDEX,
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
    state.compact = false;
    if (!panel) panel = createPanel();
    panel.style.display = "block";
    // The panel was hidden while it rendered, so ask it to measure itself now
    panel.contentWindow?.postMessage({ type: "mtg-measure" }, EXT_ORIGIN);
    if (groupId != null) selectInPanel(groupId);
    postCompact();
    layout();
  }

  function minimizePanel(groupId, title) {
    state.open = false;
    state.minimized = true;
    state.compact = false;
    minimizedGroupId = groupId;
    if (panel) panel.style.display = "none";
    bar.textContent = title || "Group";
    postCompact();
    layout();
  }

  // A click anywhere outside the panel and the strip closes the panel and makes the strip
  // icons only. Clicks inside the iframes (panel, strip) do not reach this page's document.
  function closePanelFromOutside() {
    if (!state.open || dragging || Date.now() < ignoreClicksUntil) return;
    state.open = false;
    state.compact = true;
    if (panel) panel.style.display = "none";
    postCompact();
    layout();
  }
  window.addEventListener("click", closePanelFromOutside, true);

  // Strip and bar sizes depend on the state and hover
  function layout() {
    const stripCollapsed = state.minimized && !state.hoverStrip;
    let stripHeight = STRIP_HEIGHT;
    if (isCompact()) stripHeight = STRIP_COMPACT;
    else if (stripCollapsed) stripHeight = STRIP_COLLAPSED;
    strip.style.height = `${stripHeight}px`;
    postCompact();
    postActive();

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
    } else if (type === "mtg-active" && panel && event.source === panel.contentWindow) {
      activeGroupId = groupId ?? null;
      postActive();
    } else if (type === "mtg-drag" && event.source === strip.contentWindow) {
      dragging = Boolean(event.data.on);
      if (!dragging) ignoreClicksUntil = Date.now() + 300;
    } else if (type === "mtg-open") {
      openPanel(groupId ?? null);
    } else if (type === "mtg-close") {
      closePanelFromOutside();
    } else if (type === "mtg-ready" && panel && event.source === panel.contentWindow) {
      panelReady = true;
      if (state.open) panel.contentWindow.postMessage({ type: "mtg-measure" }, EXT_ORIGIN);
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
