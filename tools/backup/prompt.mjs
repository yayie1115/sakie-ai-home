import {StringDecoder} from 'node:string_decoder';
// A TTY-only hidden prompt. No environment, argv, ordinary file or piped secret input.
export async function hiddenPassphrase(label,{input=process.stdin,output=process.stderr}={}){
 if(!input.isTTY||!output.isTTY||typeof input.setRawMode!=='function')throw Error('INTERACTIVE_TTY_REQUIRED');
 output.write(label);const raw=input.isRaw;input.setRawMode(true);input.resume();
 return new Promise((ok,fail)=>{let value='';const decoder=new StringDecoder('utf8');
  const end=(error)=>{input.removeListener('data',data);input.removeListener('error',bad);input.setRawMode(raw??false);input.pause();output.write('\n');const result=value;value='';if(error)fail(error);else ok(result);};
  const bad=()=>end(Error('INPUT_ABORTED'));
  const data=chunk=>{for(const char of typeof chunk==='string'?chunk:decoder.write(chunk)){
   if(char==='\x03'||char==='\x04'||char==='\x1b'){end(Error('INPUT_ABORTED'));return;}
   if(char==='\r'||char==='\n'){end();return;}
   if(char==='\b'||char==='\x7f')value=Array.from(value).slice(0,-1).join('');
   else if(char>=' '){value+=char;if(value.length>1024){end(Error('PASSPHRASE_POLICY'));return;}}
  }};
  input.on('data',data);input.once('error',bad);
 });
}
