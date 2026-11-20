import vm from 'node:vm';
export function panelListHarness(source){
 const slots=[],effects=[],requests=[];let cursor=0;const h=(type,props,...children)=>({type,props,children});
 const context={h,ui:{Btn:'button'},React:{Fragment:'fragment'},JSON,setInterval,clearInterval,
  useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return [slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}];},
  useRef(initial){const i=cursor++;return slots[i]??={current:initial};},
  useEffect(fn,deps){const i=cursor++,old=slots[i];if(!old||deps.some((x,n)=>!Object.is(x,old.deps[n]))){slots[i]={deps};effects.push(()=>{old?.cleanup?.();slots[i].cleanup=fn();});}},
  read(name,params){return new Promise(resolve=>requests.push({name,params,resolve}));},
 };
 const start=source.indexOf('function LazyList('),end=source.indexOf('\nfunction ',start+1);
 if(start<0||end<0)throw Error('LazyList component boundary missing');
 const code=source.slice(start,end);
 const component=vm.runInNewContext('('+code+')',context);
 return {requests,render(scope){cursor=0;const tree=component({name:'recalls',scope,render:x=>h('p',null,x.label)});for(const f of effects.splice(0))f();return tree;},close(){for(const s of slots)s?.cleanup?.();}};
}
