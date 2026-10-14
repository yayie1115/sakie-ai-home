import { Link, Outlet } from 'react-router';
import { modules } from '../modules';

export function Layout() {
  return <><header><h1>sakie-ai-home</h1><nav aria-label="主导航">
    <Link to="/">首页</Link>{modules.map(({ name, label }) => <Link key={name} to={`/${name}`}>{label}</Link>)}
  </nav></header><main><Outlet /></main></>;
}
