// Shared U-layer display contract; these are storage projections, not extra M directories.
export const HEAD_VOLUME={center:[0,600,0],radii:[285,260,205]};
export const LAYERS = [
  {id:'recent',name:'近事记忆',position:[-100,807,-45],radii:[37,26,28],color:'#b8f5ff',description:'最近完整原话：近期保护窗口内不做有损压缩。'},
  {id:'warm',name:'巩固记忆',position:[-30,725,-75],radii:[44,25,31],color:'#a6caff',description:'完整温存和无损冷档；从这里分流至重要保存或普通衰退。'},
  {id:'deep',name:'外显记忆',position:[-85,590,-115],radii:[38,30,27],color:'#c4b7ff',description:'重要的准确内容和必要原证据；概括或形成准则不会替代原文。'},
  {id:'mature',name:'图式记忆',position:[-99,490,-95],radii:[35,26,29],color:'#edb3dc',description:'带条件、支持和反例的模式与行为准则；可核对后接入中枢。'},
  {id:'implicit',name:'内隐记忆',position:[-25,420,-45],radii:[42,19,29],color:'#f4dc9d',description:'人工核对或独立反馈自动成熟的条件准则。正文仍在 U，同一对象投影到相应中枢并在匹配时调整工作参数；可暂停或撤回。'},
  {id:'intent',name:'前瞻记忆',position:[185,753,-35],radii:[29,25,27],color:'#f4d395',description:'承诺、计划与定时或条件触发事项，未见真实结果不算完成。'},
  {id:'faint',name:'记忆残迹',position:[105,555,-120],radii:[38,32,29],color:'#9aaeca',description:'普通内容逐渐保留为要旨或线索；满足真实遗忘条件后化作流星，保护内容不走这条路线。'},
];
for(const layer of LAYERS)layer.y=layer.position[1];
export const MEMORY_FLOWS=[['recent','warm'],['warm','deep'],['deep','mature'],['mature','implicit'],['warm','faint'],['faint','forgotten'],['recent','intent']].map(([from,to])=>({from:'L:'+from,to:'L:'+to}));
export const FORGET_EXIT={id:'L:forgotten',name:'遗忘终点',position:[145,480,-70],radii:[16,18,16],color:'#adb1d4'};
