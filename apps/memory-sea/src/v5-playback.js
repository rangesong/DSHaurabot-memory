export function atlasHostWindow(win){
  let host=win;
  try{while(host?.parent&&host.parent!==host){void host.parent.document;host=host.parent;}}catch{}
  return host;
}
export function atlasForeground(doc=document){
  if(doc.hidden)return false;
  const host=atlasHostWindow(doc.defaultView)?.document??doc;
  return !host.hidden&&(host.hasFocus()||doc.hasFocus());
}

export function atlasPanelMessage(event,win=window){
  if(win.parent===win||event.source!==win.parent||event.origin!==win.location.origin)return;
  if(event.data?.type==='thinkstar-atlas-visibility'&&typeof event.data.visible==='boolean')return event.data.visible;
}

/** Resume only after a fresh snapshot; an older read must never restart a background view. */
export class AtlasPlayback {
  constructor({refresh,start,stop,onError=()=>{}}){Object.assign(this,{refresh,start,stop,onError});this.generation=0;this.active=false;this.ready=false;this.pending=null;}
  update(active,{retry=false}={}){
    if(active===this.active&&!retry){if(active&&this.ready)this.start();return this.pending??Promise.resolve();}
    this.active=active;this.ready=false;const generation=++this.generation;this.stop();
    if(!active){this.pending=null;return Promise.resolve();}
    const task=Promise.resolve().then(()=>this.refresh()).then(result=>{
      if(result!==false&&this.active&&generation===this.generation){this.ready=true;this.start();}
    }).catch(error=>{if(generation===this.generation)this.onError(error);}).finally(()=>{if(this.pending===task)this.pending=null;});
    this.pending=task;return task;
  }
}

/** Focus moving between the host and its iframe is not leaving the app. */
export function bindAtlasActivity({win=window,doc=document,playback,foreground=()=>atlasForeground(doc),interval=1000}){
  const host=atlasHostWindow(win),listeners=[];let settleTimer=null;
  const update=()=>playback.update(foreground());
  const settle=()=>{win.clearTimeout(settleTimer);settleTimer=win.setTimeout(update,0);};
  const listen=(target,type,fn)=>{target.addEventListener(type,fn);listeners.push(()=>target.removeEventListener(type,fn));};
  for(const target of new Set([win,host])){listen(target,'focus',settle);listen(target,'blur',settle);}
  listen(doc,'visibilitychange',update);listen(win,'pageshow',settle);
  // Recover if the host omits a focus event or a transient blur stopped a frame.
  // Repeated foreground checks reuse the snapshot and never repeat its read.
  const timer=win.setInterval(update,interval);
  const dispose=()=>{win.clearTimeout(settleTimer);win.clearInterval(timer);for(const remove of listeners)remove();};
  listen(win,'pagehide',event=>{playback.update(false);if(!event.persisted)dispose();});
  update();return {update,dispose};
}
