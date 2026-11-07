import type { Writable } from 'node:stream';

export function eventSink(stream: Writable): (payload: string) => void {
  let blocked=false, pending:string|null=null, timeout:ReturnType<typeof setTimeout>|undefined;
  const clear=()=>{if(timeout)clearTimeout(timeout);timeout=undefined;};
  const send=(payload:string)=>{
    if(stream.destroyed||stream.writableEnded)return;
    if(Buffer.byteLength(payload)>1024*1024){stream.end();return;}
    if(blocked){pending=payload;return;}
    blocked=!stream.write(payload);
    if(blocked){timeout=setTimeout(()=>stream.end(),30000);timeout.unref();}
  };
  stream.on('drain',()=>{blocked=false;clear();const latest=pending;pending=null;if(latest)send(latest);});
  stream.on('close',()=>{clear();pending=null;});
  stream.on('finish',clear);
  return send;
}
