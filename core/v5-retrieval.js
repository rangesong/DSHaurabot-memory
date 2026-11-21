/** A local, derived ranking signal. It never changes evidence strength or canonical text. */
export function retrievalTokens(text){
  const segments=String(text??'').normalize('NFKC').toLocaleLowerCase().match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[\p{L}\p{N}_:-]+/gu)??[];
  return segments.flatMap(segment=>{
    if(!/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(segment))return [segment];
    const chars=Array.from(segment);
    return Array.from({length:Math.max(1,chars.length-1)},(_,i)=>chars.slice(i,i+2).join(''));
  });
}
const QUESTION_FILLER=new Set('你还 还记 记得 记不 不记 什么 么吗 是什 叫什 吗我 我给 我的 你的 他的 她的 以前 之前 那个 这个 多少 怎么 后来 了吗 吗呢 了吧 说过 上次 时候 以后 每天 主人 用户 要求 希望 原来 我们 可以 需要'.split(' '));
export function relevantQueryTerms(text){const terms=[...new Set(retrievalTokens(text))].filter(token=>!QUESTION_FILLER.has(token)&&!/(?:^[的了么吗呢呀啊]|[的了么吗呢呀啊]$)/u.test(token)).slice(0,32);const precise=terms.filter(term=>!['今天','现在','项目','一下','一下子','这次'].includes(term));return precise.length?precise:terms;}
export function bm25Scores(query,documents,{k1=1.2,b=.75,queryTerms=null}={}){
  const terms=[...new Set(queryTerms??retrievalTokens(query))],rows=documents.map(doc=>{const tokens=retrievalTokens(doc.text),counts=new Map();for(const token of tokens)counts.set(token,(counts.get(token)??0)+1);return {...doc,length:tokens.length,counts};});
  const average=rows.reduce((n,row)=>n+row.length,0)/Math.max(1,rows.length)||1,df=new Map(terms.map(term=>[term,rows.filter(row=>row.counts.has(term)).length]));
  return new Map(rows.map(row=>{
    let score=0,hits=0;for(const term of terms){const frequency=row.counts.get(term)??0;if(!frequency)continue;hits++;const idf=Math.log(1+(rows.length-df.get(term)+.5)/(df.get(term)+.5));score+=idf*frequency*(k1+1)/(frequency+k1*(1-b+b*row.length/average));}
    return [row.id,{score,coverage:terms.length?hits/terms.length:0,matched_terms:hits}];
  }));
}
