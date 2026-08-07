/**
 * Service worker.
 *
 * Deliberately almost empty. The side panel is a normal extension page, so it
 * can call chrome.scripting and chrome.tabs itself; routing that through here
 * would only add a hop that dies whenever the worker is evicted. All this does
 * is make the toolbar button open the panel.
 */

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
    // Chrome < 114. The manifest declares minimum_chrome_version, so this is
    // only reachable on a build that ignores it.
  });
});

// onInstalled does not fire when the worker restarts on an already-installed
// extension, and the behaviour flag does not survive eviction on every build.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
