// Builds the embeddable component:
//   dist/spectra-logo.js        <spectra-logo> custom element, one self-contained file (classic <script> or ES module side-effect import)
//   dist/spectra-logo-react.js  thin React wrapper (React is a peer import, not bundled)
// Optional: if esbuild is installed (npm i -D esbuild) the element bundle is minified; otherwise it ships readable.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
const r = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const pkg = JSON.parse(r('./package.json'));
// GLSL in the engine's template literals: drop indentation and whole-line comments (newlines kept, so trailing // comments stay safe)
const squeezeGLSL = (src) => src.replace(/`#version 300 es[\s\S]*?`|`\n  float g1\([\s\S]*?`/g, (m) => m.split('\n').map((l) => l.trim()).filter((l) => !l.startsWith('//')).join('\n'));
const parts = [r('./src/samples.js'), r('./src/sdf.js'), squeezeGLSL(r('./src/engine.js'))].join('\n;\n');
let js = `/*! spectra-logo v${pkg.version} | MIT | <spectra-logo> WebGL2 glass/chrome logo with a spectral light beam */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined' || !window.customElements || window.customElements.get('spectra-logo')) return;
  // The engine files publish window.Spectra*; capture them privately and restore whatever the page had.
  var NAMES = ['SpectraSamples', 'SpectraSDF', 'SpectraEngine'], had = {}, prev = {};
  NAMES.forEach(function (n) { had[n] = Object.prototype.hasOwnProperty.call(window, n); prev[n] = window[n]; });
${parts}
;
  var DEPS = { Engine: window.SpectraEngine, SDF: window.SpectraSDF, Samples: window.SpectraSamples };
  NAMES.forEach(function (n) { if (had[n]) window[n] = prev[n]; else delete window[n]; });
${r('./src/embed/spectra-logo.js')}
})();
`;
let minified = false;
try {
  const esbuild = await import('esbuild');
  js = (await esbuild.transform(js, { minify: true, target: 'es2020', legalComments: 'inline' })).code;
  minified = true;
} catch (e) { /* esbuild not installed: ship unminified */ }
mkdirSync(new URL('./dist/', import.meta.url), { recursive: true });
writeFileSync(new URL('./dist/spectra-logo.js', import.meta.url), js);
copyFileSync(new URL('./src/embed/spectra-logo-react.js', import.meta.url), new URL('./dist/spectra-logo-react.js', import.meta.url));
copyFileSync(new URL('./src/embed/embed-demo.html', import.meta.url), new URL('./dist/embed-demo.html', import.meta.url));
const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log('dist/spectra-logo.js', kb(js.length), '(gzip ' + kb(gzipSync(js).length) + (minified ? ', minified)' : ', unminified)'));
console.log('dist/spectra-logo-react.js, dist/embed-demo.html');
