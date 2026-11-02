import { createRoot } from 'react-dom/client';
import './theme.css';
import { App } from './App.tsx';

async function start(): Promise<void> {
  // Development only: a stand-in bridge for layout checks in a desktop browser (?mock=1).
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('mock') === '1') {
    await import('../../dev/mockBridge.ts');
  }
  const root = document.getElementById('root');
  if (root) createRoot(root).render(<App />);
}

void start();