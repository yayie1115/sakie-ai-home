import {useCallback,useEffect,useState,type Dispatch,type SetStateAction} from 'react';

/** Transient feedback; repeating a notice restarts its display time. */
export function useNotice():[string,Dispatch<SetStateAction<string>>]{
 const [notice,setNotice]=useState({text:'',revision:0});
 const show=useCallback<Dispatch<SetStateAction<string>>>(next=>{
  setNotice(previous=>({text:typeof next==='function'?next(previous.text):next,revision:previous.revision+1}));
 },[]);
 useEffect(()=>{
  if(!notice.text)return;
  const timer=setTimeout(()=>setNotice(previous=>previous.revision===notice.revision?{text:'',revision:previous.revision}:previous),3000);
  return()=>clearTimeout(timer);
 },[notice]);
 return [notice.text,show];
}