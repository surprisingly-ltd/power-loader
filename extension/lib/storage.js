// The background is the only writer. Other contexts retry pure mutations when
// another writer has committed since their snapshot was read.
/* global browser */
const COMMIT = 'powerloader:storage-commit';
const WIPE = 'powerloader:storage-wipe';
// case: the one active case. teardown: a Finish or Discard in progress, completed at the next start if interrupted.
// cases, activeCaseId, profiles, profileSettings: data from Power Loader 0.5, kept until the caseworker downloads or deletes it.
export const KEYS = ['case', 'teardown', 'receipt', 'starred', 'library', 'flows', 'processLog', 'settings',
  'cases', 'activeCaseId', 'profiles', 'profileSettings'];
let writer = null;

export function registerStorageWriter() {
  if (writer) return;
  let tail = Promise.resolve();
  writer = (message) => {
    const work = tail.then(async () => {
      if (message.type === WIPE) {
        await browser.storage.local.clear();
        // A fresh revision, so a snapshot taken before the wipe can never commit after it.
        await browser.storage.local.set({ storageRevision: Date.now() });
        return true;
      }
      if (!message.patch || Object.keys(message.patch).some((k) => !KEYS.includes(k))) {
        throw new Error('Invalid storage mutation');
      }
      const { storageRevision = 0 } = await browser.storage.local.get('storageRevision');
      if (message.revision !== storageRevision) return false;
      await browser.storage.local.set({ ...message.patch, storageRevision: storageRevision + 1 });
      return true;
    });
    tail = work.catch(() => {}); // A failed commit must not block later ones.
    return work;
  };
  browser.runtime.onMessage.addListener((message, sender) => {
    if (message?.type !== COMMIT && message?.type !== WIPE) return undefined;
    // Firefox includes sender.tab for our full-page extension views too. Admit those pages,
    // while keeping content scripts on casework sites outside the storage-writer boundary.
    const extensionPage = typeof sender.url === 'string' && sender.url.startsWith(browser.runtime.getURL(''));
    if (sender.id !== browser.runtime.id || (sender.tab && !extensionPage)) return Promise.reject(new Error('Invalid storage sender'));
    return writer(message);
  });
}

// fn must be synchronous and safe to replay: no network calls or external side effects.
// Return { patch, result }; omit patch for a read that needs no mutation. keys limits what is read;
// any commit since the snapshot still forces a replay.
export async function mutateStorage(fn, keys = KEYS) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const snapshot = await browser.storage.local.get([...keys, 'storageRevision']);
    const { patch, result } = fn(snapshot);
    if (!patch) return result;
    const message = { type: COMMIT, revision: snapshot.storageRevision || 0, patch };
    const committed = await (writer ? writer(message) : browser.runtime.sendMessage(message));
    if (committed === true) return result;
    if (committed !== false) throw new Error('The background storage writer is unavailable');
  }
  throw new Error('Storage is busy; please try again');
}

// "Delete all Power Loader data": queued behind any commit in flight, so nothing half-written survives it.
export async function wipeStorage() {
  const message = { type: WIPE };
  const done = await (writer ? writer(message) : browser.runtime.sendMessage(message));
  if (done !== true) throw new Error('The background storage writer is unavailable');
}
