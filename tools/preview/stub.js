// A stand-in for the WebExtension `browser` API, so the extension's own pages can run in a plain browser tab
// for screenshots (tools/preview/shoot.mjs). Storage is in memory and seeded with the demo library; the
// "active tab" is a demo page, read with the real extraction engine. Not shipped in the extension.
(() => {
  const cfg = window.__preview || {};
  const ORIGIN = location.origin;
  const listeners = () => ({ fns: [], addListener(fn) { this.fns.push(fn); }, removeListener(fn) { this.fns = this.fns.filter((f) => f !== fn); } });
  const changed = listeners();
  const local = cfg.local ? structuredClone(cfg.local) : {};
  const session = cfg.session ? structuredClone(cfg.session) : {};
  const area = (data, name) => ({
    get: async (keys) => {
      const want = keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
      return structuredClone(Object.fromEntries(want.filter((k) => k in data).map((k) => [k, data[k]])));
    },
    set: async (patch) => {
      const changes = Object.fromEntries(Object.keys(patch).map((k) => [k, { oldValue: data[k], newValue: structuredClone(patch[k]) }]));
      Object.assign(data, structuredClone(patch));
      queueMicrotask(() => changed.fns.forEach((fn) => fn(changes, name)));
    },
    remove: async (keys) => { for (const k of [keys].flat()) delete data[k]; },
    clear: async () => { for (const k of Object.keys(data)) delete data[k]; },
  });
  window.__previewStorage = { local, session };

  // The active tab: a demo page at its library address, fetched from this server.
  let page = { id: 1, windowId: 1, active: true, url: cfg.url || 'http://localhost:8787/demo/index.html', title: '' };
  const docs = new Map();
  async function pageDoc(url) {
    const path = url.startsWith('http://localhost:8787/') ? url.slice('http://localhost:8787'.length).split(/[?#]/)[0] : null;
    if (!path) return document.implementation.createHTMLDocument('');
    if (!docs.has(path)) docs.set(path, fetch(ORIGIN + path).then((r) => r.text()).then((t) => new DOMParser().parseFromString(t, 'text/html')));
    return docs.get(path);
  }
  const runtime = listeners(), tabsUpdated = listeners(), tabsActivated = listeners();
  window.__previewGo = (file) => {
    page = { ...page, url: `http://localhost:8787/demo/${file}` };
    tabsActivated.fns.forEach((fn) => fn({ windowId: 1, tabId: 1 }));
  };
  const E = () => globalThis.PowerLoaderExtract;
  const opened = [];
  window.__previewOpened = opened;
  globalThis.browser = {
    storage: { local: area(local, 'local'), session: area(session, 'session'), managed: { get: async () => cfg.managed || {} }, onChanged: changed },
    runtime: {
      id: 'preview', getURL: (p) => `${ORIGIN}/extension/${String(p).replace(/^\//, '')}`, getManifest: () => ({ version: '0.7.0', name: 'Power Loader' }), onMessage: runtime,
      sendMessage: async (msg) => {
        // The background script is the only storage writer; this plays its part (lib/storage.js).
        if (msg?.type === 'powerloader:storage-commit') {
          if ((local.storageRevision || 0) !== msg.revision) return false;
          await browser.storage.local.set({ ...msg.patch, storageRevision: (local.storageRevision || 0) + 1 });
          return true;
        }
        if (msg?.type === 'powerloader:storage-wipe') { await browser.storage.local.clear(); await browser.storage.local.set({ storageRevision: Date.now() }); return true; }
        const out = await Promise.all(runtime.fns.map((fn) => fn(msg, { id: 'preview' })));
        return out.find((x) => x !== undefined);
      },
    },
    windows: { getCurrent: async () => ({ id: 1 }) },
    permissions: { contains: async () => true, request: async () => true, onAdded: listeners(), onRemoved: listeners() },
    scripting: { executeScript: async () => [] },
    sidebarAction: { open: async () => {}, close: async () => {} },
    downloads: { download: async () => 1, onChanged: listeners() },
    tabs: {
      query: async () => [page], get: async () => page, getCurrent: async () => page, onUpdated: tabsUpdated, onActivated: tabsActivated,
      create: async (o) => { opened.push(o.url); return { id: 2 }; }, update: async () => page, remove: async () => {},
      captureVisibleTab: async () => '',
      sendMessage: async (id, msg) => {
        const d = await pageDoc(page.url);
        if (msg.type === 'powerloader:ping') return true;
        if (msg.type === 'powerloader:applies') return msg.profiles.map((p) => E().profileApplies(p, page.url, d));
        if (msg.type === 'powerloader:extract') return { ...E().extract(d, msg.profile, { baseUrl: page.url }), url: page.url, title: d.title };
        if (msg.type === 'powerloader:pageText') return { text: d.body.textContent, url: page.url, title: d.title };
        if (msg.type === 'powerloader:probe') return Object.fromEntries(Object.entries(msg.profile.fields).map(([k, s]) => [k, E().probe(d, s)]));
        if (msg.type === 'powerloader:describeForm') {
          const controls = [...d.querySelectorAll('input:not([type=hidden]), textarea, select')].map((el) => ({ selector: `#${el.id}`, label: d.querySelector(`label[for="${el.id}"]`)?.textContent || el.id }));
          return { url: page.url, documentId: 'doc-1', controls, groups: [] };
        }
        if (msg.type === 'powerloader:fill') return { filled: msg.plan.items.map((i) => ({ target: i.target, label: i.target })), failed: [] };
        return null;
      },
    },
  };

  // The demo library as a stored set, so the sidebar starts connected.
  window.__previewLibrary = async () => {
    const manifest = await fetch(`${ORIGIN}/demo/library/library.json`).then((r) => r.json());
    const files = {};
    for (const f of manifest.files) files[f.path] = await fetch(`${ORIGIN}/demo/library/${f.path}`).then((r) => r.json());
    return { commit: manifest.commit, message: manifest.message, syncedAt: new Date().toISOString(), manifest, files };
  };
})();
