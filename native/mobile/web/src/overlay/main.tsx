// installFrameCap must be the first import: it replaces requestAnimationFrame before the rig loads.
import { setFrameCap } from '../shared/installFrameCap.ts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './overlay.css';
import { OverlayApp } from './OverlayApp.tsx';
import { request } from '../shared/bridge.ts';

function reportError(message: string): void {
  // Short, payload-free text only. Rejects quietly when there is no native side.
  request('rig.error', { message: message.slice(0, 200) }).catch(() => undefined);
}

window.addEventListener('error', (event) => reportError(event.message || 'script error'));
window.addEventListener('unhandledrejection', () => reportError('unhandled promise rejection'));

const root = document.getElementById('root');
if (root) createRoot(root).render(<StrictMode><OverlayApp setFps={setFrameCap} /></StrictMode>);