// Integration smoke check in a temporary extension copy: bundled module import, OCR and PDF text.
// Uses only a local result server and synthetic data. Set POWERLOADER_FIREFOX to the Firefox executable.
import fs from 'node:fs/promises';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../..',import.meta.url));
const temp=await fs.mkdtemp(path.join((await import('node:os')).tmpdir(),'powerloader-runtime-'));
await fs.cp(`${root}/extension`,temp,{recursive:true});
let child;
const result= new Promise(resolve=>{
 const server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;res.end('OK');resolve(body);server.close();});
 server.listen(0,'127.0.0.1', async()=>{
  const port=server.address().port;
  const manifest=JSON.parse(await fs.readFile(`${temp}/manifest.json`));
  manifest.background.scripts=['smoke.js'];
  manifest.host_permissions=[`http://127.0.0.1/*`];
  await fs.writeFile(`${temp}/manifest.json`,JSON.stringify(manifest));
  await fs.writeFile(`${temp}/smoke.js`, `
const results = {};
try {
 const {env, AutoTokenizer} = await import('./vendor/transformers.min.js');
 results.transformers = !!env.backends.onnx.wasm && typeof AutoTokenizer.from_pretrained === 'function';
 const {ocrImage, stopOcr} = await import('./lib/reader/ocr.js');
 const canvas = document.createElement('canvas'); canvas.width=700;canvas.height=140;
 const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,700,140);ctx.fillStyle='black';ctx.font='bold 60px sans-serif';ctx.fillText('HELLO FIREFOX',30,90);
 const ocr = await ocrImage(canvas.toDataURL());results.ocrText=ocr.text.trim();results.ocr=ocr.text.includes('HELLO') && ocr.text.includes('FIREFOX');await stopOcr();
 const pdfjs=await import('./vendor/pdfjs/pdf.min.mjs');pdfjs.GlobalWorkerOptions.workerSrc=browser.runtime.getURL('vendor/pdfjs/pdf.worker.min.mjs');
 const text='%PDF-1.1\\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\\n4 0 obj<</Length 43>>stream\\nBT /F1 12 Tf 10 100 Td (Hello Firefox) Tj ET\\nendstream\\nendobj\\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\\ntrailer<</Root 1 0 R>>\\n%%EOF';
 const {openPdf,pdfText}=await import('./lib/reader/pdf.js');const pdf=await openPdf(pdfjs,new TextEncoder().encode(text));const pages=await pdfText(pdf);results.pdf=pages[0].text.includes('Hello Firefox');await pdf.destroy();
} catch(e) {results.error=e.message; results.stack=e.stack;}
await fetch('http://127.0.0.1:${port}/result',{method:'POST',body:JSON.stringify(results)});
`);
  child=spawn(`${root}/node_modules/.bin/web-ext`,['run','--source-dir',temp,'--firefox',process.env.POWERLOADER_FIREFOX || 'firefox','--arg=-headless','--no-input','--no-reload'],{cwd:root,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',x=>process.stdout.write(x));child.stderr.on('data',x=>process.stderr.write(x));
 });
 setTimeout(()=>{server.close();resolve(JSON.stringify({error:'Timed out waiting for runtime smoke result'}))},50000).unref();
});
const output=await result;console.log('RESULT',output);child?.kill('SIGINT');
await fs.rm(temp,{recursive:true,force:true});
const parsed=JSON.parse(output);process.exitCode=parsed.error || !parsed.ocr || !parsed.pdf || !parsed.transformers ? 1:0;
