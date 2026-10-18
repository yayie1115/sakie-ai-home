import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, useLocation } from 'react-router';
import { AppRouter } from './app/router';
import {M0Boundary} from './modules/chat/m0/M0Boundary';
import './styles.css';
import { AuthenticationGate } from './app/AuthenticationGate';

/** Re-evaluate the public synthetic preview exception on every in-app navigation. */
function ApplicationRoutes() {
  const { pathname } = useLocation();
  if(pathname==='/m0/chat')return <M0Boundary><AppRouter/></M0Boundary>;
  return pathname === '/demo/chat-group'
    ? <AppRouter />
    : <AuthenticationGate><AppRouter /></AuthenticationGate>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><BrowserRouter><ApplicationRoutes /></BrowserRouter></StrictMode>,
);
