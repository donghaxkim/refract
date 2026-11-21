// Inlines src/* into one self-contained dist/index.html
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const r = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
let ui = r('./src/ui.html');
let head = '';
ui = ui.replace(/<!--\s*HEAD:([\s\S]*?)-->/, (_, h) => { head = h.trim(); return ''; });
const css = r('./src/ui.css');
const js = ['./src/samples.js', './src/sdf.js', './src/engine.js', './src/mesh.js', './src/ui.js'].map(r).join('\n;\n');
const boot = `
(function(){
  function fail(msg){
    var el = document.createElement('div'); el.className = 'refract-fatal';
    el.setAttribute('role','alert');
    el.innerHTML = '<strong>Refract needs WebGL2</strong><span>' + msg + '</span>';
    document.body.appendChild(el);
  }
  function start(){
    var canvas = document.getElementById('refract-canvas');
    var engine;
    try { engine = new RefractEngine(canvas); }
    catch (e) { console.error(e); fail(String(e && e.message || e)); return; }
    window.refract = engine;
    var ro = new ResizeObserver(function(){ engine.resize(); }); ro.observe(canvas);
    window.addEventListener('resize', function(){ engine.resize(); });
    try { RefractUI.init(engine, { RefractSDF: window.RefractSDF, RefractSamples: window.RefractSamples, defaultSample: 'hermes' }); }
    catch (e) { console.error(e); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();`;
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Refract</title>
<meta name="description" content="Turn any SVG logo into spectral glass or chrome, rendered live with WebGL2.">
${head}
<style>
${css}
.refract-fatal{position:fixed;inset:auto 16px 16px 16px;margin:auto;max-width:420px;padding:16px 18px;border-radius:12px;background:#111214;color:#e8e8ea;border:1px solid rgba(255,255,255,.12);font:13px/1.5 system-ui,sans-serif;display:grid;gap:4px;z-index:9999}
</style>
</head>
<body>
${ui}
<script>
${js}
${boot}
</script>
</body>
</html>`;
mkdirSync(new URL('./dist/', import.meta.url), { recursive: true });
writeFileSync(new URL('./dist/index.html', import.meta.url), html);
console.log('dist/index.html', (html.length / 1024).toFixed(1) + ' KB');
