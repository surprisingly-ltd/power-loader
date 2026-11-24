// Save a file through browser.downloads. The blob: URL is revoked once the download has finished.
/* global browser */

export async function saveFile(filename, text, type = 'application/json', { saveAs = true } = {}) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  let id;
  try {
    id = await browser.downloads.download({ url, filename, saveAs });
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  const events = browser.downloads.onChanged;
  if (!events) { URL.revokeObjectURL(url); return id; }
  const done = (delta) => {
    if (delta.id !== id || !delta.state || delta.state.current === 'in_progress') return;
    URL.revokeObjectURL(url);
    events.removeListener(done);
  };
  events.addListener(done);
  return id;
}
