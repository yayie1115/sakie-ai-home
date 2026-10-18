import { useEffect, useRef, type PointerEvent } from 'react';
/** Long press/secondary click only. Moving to scroll cancels, ordinary taps do not select. */
export function useLongPress(open:()=>void) {
  const consumed=useRef(false);
  const hold=useRef<{timer:ReturnType<typeof setTimeout>;x:number;y:number}|null>(null);
  const cancel=()=>{if(hold.current)clearTimeout(hold.current.timer);hold.current=null;};
  useEffect(()=>cancel,[]);
  return {onPointerDown:(e:PointerEvent)=>{if(e.button!==0)return;consumed.current=false;cancel();hold.current={timer:setTimeout(()=>{hold.current=null;consumed.current=true;open();},450),x:e.clientX,y:e.clientY};},
    onPointerMove:(e:PointerEvent)=>{if(hold.current&&Math.hypot(e.clientX-hold.current.x,e.clientY-hold.current.y)>8)cancel();},
    onPointerUp:cancel,onPointerCancel:cancel,onPointerLeave:cancel,
    onClickCapture:(e:React.MouseEvent)=>{if(consumed.current){e.preventDefault();e.stopPropagation();consumed.current=false;}},
    onContextMenu:(e:React.MouseEvent)=>{e.preventDefault();cancel();consumed.current=true;open();}};
}
