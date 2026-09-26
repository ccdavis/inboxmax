import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import { isDesktop } from './api'
import App from './App.jsx'
import DesktopApp from './DesktopApp.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {isDesktop ? (
      <DesktopApp />
    ) : (
      <BrowserRouter>
        <App />
      </BrowserRouter>
    )}
  </StrictMode>,
)
