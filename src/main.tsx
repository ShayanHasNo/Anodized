import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Analytics } from '@vercel/analytics/react';
import App from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    {/* No-ops in local dev; only reports once deployed to Vercel. */}
    <Analytics />
  </StrictMode>,
);
