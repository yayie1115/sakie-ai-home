import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { AppRouter } from './app/router';
import './styles.css';
import { AuthenticationGate } from './app/AuthenticationGate';

createRoot(document.getElementById('root')!).render(
  <StrictMode><BrowserRouter><AuthenticationGate><AppRouter /></AuthenticationGate></BrowserRouter></StrictMode>,
);
