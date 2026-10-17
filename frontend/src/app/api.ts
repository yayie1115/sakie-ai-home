import { createContext, useContext } from 'react';
export class ApiError extends Error { constructor(readonly status: number, readonly code: string) {super(code);} }
export type AuthenticatedApi = <T>(path: string, init?: RequestInit) => Promise<T>;
export const AuthenticatedApiContext = createContext<AuthenticatedApi | null>(null);
export function useApi() { const api=useContext(AuthenticatedApiContext); if(!api) throw new Error('Authentication required'); return api; }
