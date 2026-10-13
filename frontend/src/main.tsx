import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Aplica o tema salvo antes do primeiro render para evitar flash.
try {
  const saved = localStorage.getItem('ytme_theme')
  if (saved) document.documentElement.dataset.theme = JSON.parse(saved)
} catch {
  // storage indisponível: segue com o tema padrão
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
