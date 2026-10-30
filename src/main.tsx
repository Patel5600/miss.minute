import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import OverlayApp from './OverlayApp.tsx'

const isOverlay = new URLSearchParams(window.location.search).get('overlay') === '1'
if (isOverlay) {
  document.documentElement.classList.add('mm-native-overlay')
  document.body.classList.add('mm-native-overlay')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isOverlay ? <OverlayApp /> : <App />}
  </StrictMode>,
)
