// Full extension pages (the case, the library, the activity log, the readiness check) replace the
// sidebar while open. They remember the tab, window and scroll position the caseworker came from.
// sidebarAction.open() and close() only work inside a user action, so pages call them first and leave
// the rest to the background, which outlives both.
/* global browser */

export const OPEN_PAGE = 'powerloader:open-page';
export const RETURN = 'powerloader:return';
export const PAGES = { case: 'case/case.html', library: 'library/library.html', log: 'log/log.html', ready: 'ready/ready.html' };

// Call from a click handler in the sidebar. from: { tabId, windowId, url, focus } (focus: the sidebar control's data-key).
export function openFullPage(kind, from, params = {}) {
  void browser.runtime.sendMessage({ type: OPEN_PAGE, kind, from, params }).catch(() => {});
  void browser.sidebarAction.close().catch(() => {});
}

// Call from a click handler on a full page: back to the tab the caseworker came from, with the sidebar open.
// From the full page itself, or from the sidebar reopened over it (which names that page's tab).
export async function returnToSidebar({ pageTabId } = {}) {
  const opening = pageTabId == null ? browser.sidebarAction.open().catch(() => {}) : null;
  const { fullPage } = await browser.storage.session.get('fullPage');
  const from = fullPage?.from;
  let exists = false;
  if (from?.tabId != null) exists = await browser.tabs.get(from.tabId).then(() => true, () => false);
  await opening;
  if (!exists) return { ok: false, reason: 'The tab you came from was closed. The sidebar is open in this window.' };
  const self = pageTabId != null ? { id: pageTabId } : await browser.tabs.getCurrent();
  await browser.runtime.sendMessage({ type: RETURN, pageTabId: self?.id });
  return { ok: true };
}

/** Background side: open the page, and handle the way back. */
export function registerPageRoutes({ ask }) {
  browser.runtime.onMessage.addListener((msg, sender) => {
    if (sender.id !== browser.runtime.id || sender.tab?.url?.startsWith('http')) return undefined;
    if (msg?.type === OPEN_PAGE && PAGES[msg.kind]) {
      return (async () => {
        const from = msg.from || {};
        let scroll = null;
        if (from.tabId != null) scroll = await ask(from.tabId, { type: 'powerloader:scroll' }).catch(() => null);
        await browser.storage.session.set({ fullPage: { kind: msg.kind, from: { ...from, scroll } } });
        const qs = new URLSearchParams(msg.params || {}).toString();
        await browser.tabs.create({ url: browser.runtime.getURL(`${PAGES[msg.kind]}${qs ? `?${qs}` : ''}`), windowId: from.windowId });
        return true;
      })();
    }
    if (msg?.type === RETURN) {
      return (async () => {
        const { fullPage } = await browser.storage.session.get('fullPage');
        const from = fullPage?.from;
        if (!from) return false;
        await browser.tabs.update(from.tabId, { active: true });
        if (from.windowId != null) await browser.windows.update(from.windowId, { focused: true }).catch(() => {});
        if (from.scroll) await ask(from.tabId, { type: 'powerloader:scrollTo', ...from.scroll }).catch(() => {});
        // The sidebar focuses this control when it renders, then forgets it.
        await browser.storage.session.set({ returnFocus: from.focus || null });
        await browser.storage.session.remove('fullPage');
        if (msg.pageTabId != null) await browser.tabs.remove(msg.pageTabId).catch(() => {});
        return true;
      })();
    }
    return undefined;
  });
}
