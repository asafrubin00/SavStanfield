if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* storage blocked */ }

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
