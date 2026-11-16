import test from 'node:test';
import assert from 'node:assert/strict';
import { REGIONS } from '../core/v5-config.js';
import { headContains,memoryPoint,regionStructure } from '../apps/memory-sea/src/v5-spatial.js';

const range=(points,axis)=>Math.max(...points.map(p=>p[axis]))-Math.min(...points.map(p=>p[axis]));
function volume(points){const [a,b,c,d]=points,sub=p=>[p.x-a.x,p.y-a.y,p.z-a.z],[u,v,w]=[b,c,d].map(sub);return Math.abs(u[0]*(v[1]*w[2]-v[2]*w[1])-u[1]*(v[0]*w[2]-v[2]*w[0])+u[2]*(v[0]*w[1]-v[1]*w[0]));}

test('all region anchors including U stay inside the head with anatomical front/left/deep separation',()=>{
  for(const region of REGIONS)assert.ok(headContains(Object.fromEntries(['x','y','z'].map((a,i)=>[a,region.position[i]]))),region.id);
  const byId=id=>REGIONS.find(r=>r.id===id);
  assert.equal(byId('W4').name,'布罗卡区');assert.ok(byId('W4').position[0]>0);
  assert.ok(byId('W2').position[2]>100);assert.ok(Math.abs(byId('W1').position[0])<30);
  assert.ok(byId('W5').position[2]<0);assert.ok(byId('M4').position[2]<0);
  assert.equal(new Set(REGIONS.map(r=>r.name)).size,REGIONS.length);
});

test('every region structure is a three-dimensional cloud rather than a plane',()=>{
  for(const region of REGIONS){const cloud=regionStructure(region,60);assert.ok(cloud.every(p=>headContains(p)));assert.ok(range(cloud,'x')>20);assert.ok(range(cloud,'y')>20);assert.ok(range(cloud,'z')>20);assert.ok(volume(cloud)>1,region.id+' must span 3D');}
});

test('all storage layers and memory kinds project into non-coplanar head volumes without mutating canonical content',()=>{
  const now=1794600000000;
  for(const [kind,region] of [['raw','M4'],['experience','M2'],['pattern','M3'],['claim','M1'],['intent','M2']]){
    for(const layer of ['recent','warm','deep','mature','intent','faint']){
      const memories=Array.from({length:60},(_,i)=>({id:`spatial:${kind}:${layer}:${i}`,kind,layer,region_ids:[region],created_at:now-3600000})),before=JSON.stringify(memories),positions=memories.map(m=>memoryPoint(m,REGIONS,{now}));
      assert.ok(positions.every(p=>headContains(p)));assert.ok(volume(positions)>1);assert.ok(range(positions,'z')>20);assert.equal(JSON.stringify(memories),before);
      assert.deepEqual(memoryPoint(memories[0],REGIONS,{now}),positions[0]);
    }
  }
});

test('recent-memory settling changes height within the head and does not flatten depth',()=>{
  const now=1794600000000,memories=Array.from({length:50},(_,i)=>({id:`settle:${i}`,kind:'raw',layer:'recent',region_ids:['M4'],created_at:now}));
  const fresh=memories.map(m=>memoryPoint(m,REGIONS,{now})),aged=memories.map(m=>memoryPoint(m,REGIONS,{now:now+72*3600000}));
  assert.ok(fresh.every((p,i)=>p.y>aged[i].y)&&fresh.reduce((n,p,i)=>n+p.y-aged[i].y,0)/fresh.length>1);assert.ok(aged.every(p=>headContains(p)));assert.ok(range(aged,'z')>20);
});
