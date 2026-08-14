import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Keep favicon rooted at the site origin (avoids stale relative hrefs).
const faviconLink = document.querySelector('link[rel="icon"]');
if (faviconLink) {
  faviconLink.href = `${window.location.origin}/favicon.svg`;
}

// Swap the Google Font stylesheet from media="print" -> "all" once it has
// downloaded. This makes the request non-render-blocking without needing an
// inline `onload` handler (which is blocked by our CSP).
const _font = document.getElementById('google-font');
if (_font) {
  const apply = () => { _font.media = 'all'; };
  if (_font.sheet) apply();
  else _font.addEventListener('load', apply, { once: true });
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
