import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, useLocation } from 'react-router';
import { AppRouter } from './app/router';
import './styles.css';
import { AuthenticationGate } from './app/AuthenticationGate';

/** Re-evaluate the public synthetic preview exception on every in-app navigation. */
function ApplicationRoutes() {
  const { pathname } = useLocation();
  return pathname === '/demo/chat-group'
    ? <AppRouter />
    : <AuthenticationGate><AppRouter /></AuthenticationGate>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><BrowserRouter><ApplicationRoutes /></BrowserRouter></StrictMode>,
);
