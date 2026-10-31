import { StrictMode, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import OverlayApp from './OverlayApp.tsx'

const params = new URLSearchParams(window.location.search)
const isOverlay = params.get('overlay') === '1'
if (isOverlay) {
  document.documentElement.classList.add('mm-native-overlay')
  document.body.classList.add('mm-native-overlay')
}

const root = createRoot(document.getElementById('root')!)

// Dev-only QA pages: src/qa/<name>.tsx (gitignored), opened with ?qa=<name>.
const qaName = import.meta.env.DEV ? params.get('qa') : null
const qaPages = import.meta.env.DEV
  ? import.meta.glob<{ default: ComponentType }>('./qa/*.tsx')
  : {}
const qaLoader = qaName ? qaPages[`./qa/${qaName}.tsx`] : undefined

if (qaLoader) {
  void qaLoader().then(({ default: Page }) => {
    root.render(<StrictMode><Page /></StrictMode>)
  })
} else {
  root.render(
    <StrictMode>
      {isOverlay ? <OverlayApp /> : <App />}
    </StrictMode>,
  )
}
