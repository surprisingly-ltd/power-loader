// Parse into an inactive document with no browsing context. No captured nodes
// are ever inserted into a live extension document.
export function parseSnapshot(html, documentSource = globalThis.document) {
  if (typeof html !== 'string' || html.length > 3000000) throw new Error('Page snapshot is too large (maximum 3 million characters)');
  if (!documentSource?.implementation) throw new Error('Snapshot evaluation needs an extension document');
  const Parser = documentSource.defaultView?.DOMParser || globalThis.DOMParser;
  const doc = new Parser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script:not([type="application/ld+json"]), iframe, object, embed').forEach((n) => n.remove());
  // innerHTML reconstructs defaults; explicitly restore select state for parity.
  for (const select of doc.querySelectorAll('select')) {
    const selected = [...select.options].filter((o) => o.hasAttribute('selected'));
    if (selected.length) for (const option of select.options) option.selected = selected.includes(option);
  }
  return doc;
}

// "/clients/C-1042/notes?x=1" → "/clients/{id}/notes". Hosts, queries and fragments are dropped: they can hold identifiers.
export function pathShape(value) {
  const v = String(value || '').trim();
  if (!v || v.startsWith('#') || /^(mailto|tel|javascript|data|blob):/i.test(v)) return '';
  let path = v;
  try { path = new URL(v, 'https://x.invalid/').pathname; } catch { return ''; }
  return path.split('/').map((seg) => (/\d/.test(seg) || seg.length > 24 ? '{id}' : seg)).join('/');
}

export function cleanHtml(doc, maxChars) {
  const clone = doc.cloneNode(true);
  clone.querySelectorAll('style,noscript,svg,iframe,link,meta,template,canvas,object,embed,video,audio,source,picture,base,script:not([type="application/ld+json"])').forEach((n) => n.remove());
  clone.querySelectorAll('input[type=password],input[type=hidden],input[type=file]').forEach((n) => { n.removeAttribute('value'); });
  const keep = new Set('id class name for href src type value checked selected role aria-label title alt headers colspan scope itemprop itemtype rel lang'.split(' '));
  for (const el of clone.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      if (/token|secret|password|csrf|nonce/i.test(attr.name) || (!keep.has(attr.name) && !attr.name.startsWith('data-'))) el.removeAttribute(attr.name);
      // Links and sources keep only their path shape; data-* keep their names, not their values.
      else if (attr.name === 'href' || attr.name === 'src') el.setAttribute(attr.name, pathShape(attr.value));
      else if (attr.name.startsWith('data-')) el.setAttribute(attr.name, '');
      else if (attr.value.length > 120) el.setAttribute(attr.name, attr.value.slice(0, 120) + '…');
    }
  }
  const walker = clone.createTreeWalker(clone, 4 | 128); // text and comments
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (node.nodeType === 8) node.remove();
    else if (node.parentElement?.localName !== 'script' && node.textContent.length > 400) node.textContent = node.textContent.slice(0, 400) + '…';
  }
  const html = clone.documentElement.outerHTML.replace(/>\s+</g, '> <').replace(/[ \t\r\f\v]+/g, ' ');
  return { html: html.slice(0, maxChars), truncated: html.length > maxChars };
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
export function formForPrompt(form) {
  const control = (c) => pick(c, ['selector', 'label', 'tag', 'type', 'options', 'required', 'name', 'section']);
  return {
    controls: (form.controls || []).map(control),
    groups: (form.groups || []).map((g) => ({ ...pick(g, ['rows', 'rowCount', 'heading']), controls: (g.controls || []).map(control) })),
    buttons: (form.buttons || []).map((b) => pick(b, ['selector', 'text'])),
  };
}
