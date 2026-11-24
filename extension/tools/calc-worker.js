// Runs the calculator's search off the page's thread, so a large search can be cancelled by ending the worker.
import { solve } from '../lib/calc.js';

self.onmessage = ({ data }) => {
  try { postMessage({ ok: true, result: solve(data.chosen, data.target, data.opts) }); }
  catch (e) { postMessage({ ok: false, message: e.message }); }
};
