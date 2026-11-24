/*
 * Page snapshot for AI profile generation. Injected as a classic content script;
 * sets globalThis.PowerLoaderCapture. Copies live form state into attributes so the
 * local evaluator sees what the caseworker sees, and drops scripts/styles to save bytes.
 */
(function (root) {
  'use strict';
  root.PowerLoaderCapture = function capture() {
    const src = document.documentElement;
    const clone = src.cloneNode(true);
    const sel = 'input, textarea, select';
    const a = src.querySelectorAll(sel);
    const b = clone.querySelectorAll(sel);
    for (let i = 0; i < a.length && i < b.length; i++) {
      const o = a[i];
      const c = b[i];
      const tag = o.localName;
      if (tag === 'input') {
        const type = (o.getAttribute('type') || 'text').toLowerCase();
        if (type === 'password') c.setAttribute('value', '');
        else if (type === 'checkbox' || type === 'radio') {
          if (o.checked) c.setAttribute('checked', '');
          else c.removeAttribute('checked');
        } else c.setAttribute('value', o.value);
      } else if (tag === 'textarea') {
        c.textContent = o.value;
      } else if (tag === 'select') {
        Array.from(c.options).forEach((opt, j) => {
          if (o.options[j] && o.options[j].selected) opt.setAttribute('selected', '');
          else opt.removeAttribute('selected');
        });
      }
    }
    clone.querySelectorAll('script:not([type="application/ld+json"]), style, noscript, link[rel=stylesheet], svg').forEach((n) => n.remove());
    return { url: location.href, title: document.title, documentId: root.__powerloaderDocumentId || null, html: '<!DOCTYPE html>\n' + clone.outerHTML };
  };
})(globalThis);
