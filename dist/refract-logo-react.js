// <RefractLogo /> — thin React wrapper around the <refract-logo> custom element.
// React is a peer dependency (imported, never bundled). Works with React 17/18/19.
//   import { RefractLogo } from './refract-logo-react.js';
//   <RefractLogo sample="hermes" material="glass" background="#0b0b0c" onReady={...} style={{ height: 480 }} />
import { createElement, forwardRef, useEffect, useRef, useImperativeHandle } from 'react';
import './refract-logo.js'; // registers <refract-logo> (no-op during SSR)

const STRING_PROPS = ['src', 'text', 'sample', 'font', 'material', 'light', 'theme', 'background', 'poster', 'alt'];

export const RefractLogo = forwardRef(function RefractLogo(props, ref) {
  const { className, style, id, interactive, transparent, thickness, roundness, onReady, onError, children, ...rest } = props;
  const el = useRef(null);
  useImperativeHandle(ref, () => el.current, []);
  // events: React 18 doesn't wire custom events on custom elements, so attach them directly
  const handlers = useRef({ onReady, onError });
  handlers.current = { onReady, onError };
  useEffect(() => {
    const node = el.current; if (!node) return undefined;
    const ready = (e) => handlers.current.onReady && handlers.current.onReady(e);
    const error = (e) => handlers.current.onError && handlers.current.onError(e);
    node.addEventListener('ready', ready); node.addEventListener('error', error);
    return () => { node.removeEventListener('ready', ready); node.removeEventListener('error', error); };
  }, []);
  // map props → attributes explicitly (consistent across React versions)
  const attrs = { ref: el, class: className, style, id };
  for (const k of STRING_PROPS) if (props[k] != null && props[k] !== false) attrs[k] = String(props[k]);
  if (thickness != null) attrs.thickness = String(thickness);
  if (roundness != null) attrs.roundness = String(roundness);
  if (interactive === false) attrs.interactive = 'false';
  if (transparent) attrs.transparent = '';
  for (const k in rest) if (!STRING_PROPS.includes(k) && (/^(aria-|data-)/.test(k) || k === 'hidden' || k === 'title')) attrs[k] = rest[k];
  return createElement('refract-logo', attrs, children);
});

export default RefractLogo;
