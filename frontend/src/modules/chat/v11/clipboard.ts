/** Invoke from the copy click: WebKit requires clipboard.write before awaiting network. */
export async function copyVerified(read:Promise<string>):Promise<void>{
 const text=read.then(value=>{if(typeof value!=='string')throw Error('INVALID_COPY');return value;});
 try{if(window.isSecureContext&&navigator.clipboard?.write&&typeof ClipboardItem!=='undefined'){
  const data=text.then(value=>new Blob([value],{type:'text/plain'}));void data.catch(()=>{});await navigator.clipboard.write([new ClipboardItem({'text/plain':data})]);return;
 }}catch{/* Never copy an unchecked DOM value after a failed source read. */}
 let value:string;try{value=await text;}catch{throw Error('消息已变化或暂时无法核验，请刷新后重试。');}
 try{if(window.isSecureContext&&navigator.clipboard?.writeText){await navigator.clipboard.writeText(value);return;}}catch{}
 const selected=window.getSelection(),ranges:Range[]=[];if(selected)for(let i=0;i<selected.rangeCount;i++)ranges.push(selected.getRangeAt(i));const focused=document.activeElement as HTMLElement|null,area=document.createElement('textarea');area.value=value;area.readOnly=true;area.style.cssText='position:fixed;top:0;left:0;opacity:0;font-size:16px';document.body.append(area);
 try{area.focus({preventScroll:true});area.select();area.setSelectionRange(0,value.length);if(!document.execCommand('copy'))throw Error('COPY_FAILED');}catch{throw Error('浏览器未允许复制，请选中文字后使用系统“复制”。');}finally{area.remove();focused?.focus({preventScroll:true});if(selected){selected.removeAllRanges();for(const range of ranges)selected.addRange(range);}}
}
export function usageLine(m:{time:number;usage?:{inputTokens:number|null;outputTokens:number|null;cacheReadTokens:number|null;cacheRateApplicable?:boolean}}){const u=m.usage;const output=typeof u?.outputTokens==='number'?String(u.outputTokens):'—';const rate=u?.cacheRateApplicable===true&&typeof u.inputTokens==='number'&&u.inputTokens>0&&typeof u.cacheReadTokens==='number'&&u.cacheReadTokens>=0&&u.cacheReadTokens<=u.inputTokens?(u.cacheReadTokens/u.inputTokens*100).toFixed(1)+'%':'—';return output+' token · '+rate+' · '+new Date(m.time).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});}
