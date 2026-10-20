import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePolygonParts, polygonDifference, polygonIntersection, polygonUnion } from '../polygon-geometry.js';
import { polygonClipping } from '../vendor/polygon-clipping.js';
const rect = (left, top, right, bottom) => [[{x:left,y:top},{x:right,y:top},{x:right,y:bottom},{x:left,y:bottom},{x:left,y:top}]];
const ringArea = ring => {
  const origin = ring[0]; let sum = 0;
  for (let i = 1; i < ring.length - 1; i++) sum += (ring[i].x-origin.x)*(ring[i+1].y-origin.y)-(ring[i+1].x-origin.x)*(ring[i].y-origin.y);
  return Math.abs(sum / 2);
};
const area = parts => parts.reduce((sum,polygon)=>sum+ringArea(polygon[0])-polygon.slice(1).reduce((holes,ring)=>holes+ringArea(ring),0),0);
const inRing=(x,y,ring)=>{let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a.y>y)!==(b.y>y)&&x<(b.x-a.x)*(y-a.y)/(b.y-a.y)+a.x)inside=!inside;}return inside;};
const contains=(parts,x,y)=>parts.some(p=>inRing(x,y,p[0])&&!p.slice(1).some(r=>inRing(x,y,r)));
const close=(a,b,epsilon=1e-8)=>assert(Math.abs(a-b)<=epsilon,`${a} differs from ${b}`);

test('polygon subtraction cuts exact interior holes while holes in masks preserve islands',()=>{
  const source=[rect(0,0,20,20)],mask=rect(5,5,15,15);mask.push(...rect(8,8,12,12));
  const before=structuredClone({source,mask}),result=polygonDifference(source,[mask]);
  close(area(result),316);assert(contains(result,2,2));assert(!contains(result,6,6));assert(contains(result,10,10));
  assert.equal(polygonIntersection(result,[mask]).length,0,'No positive-area overlap remains');
  assert.deepEqual({source,mask},before);
  result[0][0][0].x=999;assert.deepEqual({source,mask},before,'Output geometry is independent');
});

test('touching and overlapping polygon parts unite without shared seams or XOR holes',()=>{
  const first=rect(0,0,10,10),second=rect(10,0,20,10),overlap=rect(8,0,12,10);
  const joined=polygonUnion([first,second,overlap]);
  assert.equal(joined.length,1);assert.equal(joined[0].length,1);close(area(joined),200);
  assert.deepEqual(polygonUnion([second,overlap,first]),joined,'Result ordering is deterministic');
  const untouched=polygonDifference([first],[rect(10,0,20,10)]);
  close(area(untouched),100);assert.equal(polygonIntersection([first],[second]).length,0,'Shared edges have no area');
});

test('difference preserves multipart gaps, open-edge notches and partly covered islands',()=>{
  const source=[rect(0,0,20,20),rect(30,0,40,10)],masks=[rect(8,-2,12,8),rect(32,2,38,8)];
  const result=polygonDifference(source,masks);
  close(area(result),432);assert(!contains(result,10,2));assert(contains(result,10,10));assert(!contains(result,35,5));assert(!contains(result,25,5));
  assert.equal(polygonIntersection(result,masks).length,0);
});

test('thin sub-millimetre polygons and source-precision cut edges are not rounded away',()=>{
  const source=[rect(2999,0,3000,10)],cut=2999.999999;
  const thin=polygonDifference(source,[rect(2998,-1,cut,11)]);
  assert(thin.length);assert(area(thin)>0);close(area(thin),(3000-cut)*10,1e-11);
  assert(thin.flat(2).some(p=>p.x===cut),'Original full precision cut coordinate is retained');
  assert.equal(polygonDifference(source,[rect(2998,-1,3001,11)]).length,0);
});

test('normalization closes and independently copies rings while rejecting invalid coordinates',()=>{
  const input=[[[{x:0,y:0},{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}]]],before=structuredClone(input);
  const out=normalizePolygonParts(input);
  assert.equal(out[0][0].length,5);assert.deepEqual(out[0][0][0],out[0][0].at(-1));assert.deepEqual(input,before);
  assert.deepEqual(normalizePolygonParts([]),[]);assert.deepEqual(polygonUnion([]),[]);assert.deepEqual(polygonDifference([],input),[]);assert.deepEqual(polygonIntersection(input,[]),[]);
  assert.throws(()=>polygonUnion([[[{x:0,y:0},{x:Infinity,y:1},{x:2,y:2}]]]),/finite/);
  assert.throws(()=>polygonUnion([[[{x:0,y:0},{x:1e12,y:1},{x:2,y:2}]]]),/bounded/);
  assert.deepEqual(normalizePolygonParts([[[{x:0,y:0},{x:1,y:1},{x:2,y:2}]]]),[]);
});

test('zero signed-area self-crossings retain their filled lobes for robust clipping',()=>{
  const bow=[[[{x:0,y:0},{x:10,y:10},{x:0,y:10},{x:10,y:0},{x:0,y:0}]]];
  const result=polygonUnion(bow);close(area(result),50);assert(result.length>0);
});

test('the vendored browser geometry engine has no global or package-install side effects',()=>{
  assert.equal(globalThis.polygonClipping,undefined);
  assert(Object.isFrozen(polygonClipping));assert.equal(typeof polygonClipping.difference,'function');
  const clone=polygonDifference([rect(0,0,10,10)],[]);assert.equal(area(clone),100);
});


test('real Beatty coincident fused edges clip completely without crashing or losing thin regions',()=>{
  // Minimized from the actual native/fused masks that raised SweepLine's
  // "Unable to find segment" at [2395.409,933.623]->[2395.606,934.906].
  const ring = [[2383.923891145944,925.5632017839989],[2385.8148134791104,924.606646397045],[2387.7612257275127,924.0887898548156],[2388.5858591543324,923.9979181421699],[2396.931,930.912],[2397.4568116297633,930.2629401905962],[2397.7537831921495,930.8921011133864],[2397.941777710145,931.6424490215272],[2398.210468188049,933.1934289508009],[2395.409,933.623],[2395.606,934.9059999999997],[2383.923891145944,925.5632017839989]].map(([x,y])=>({x,y}));
  const masks = [[ring],[[{x:2395.409,y:933.623},{x:2402.824,y:932.486},{x:2403.218,y:935.052},{x:2395.803,y:936.189},{x:2395.409,y:933.623}]]];
  const before=structuredClone(masks),subject=[rect(2370,910,2420,950)],result=polygonDifference(subject,masks);
  assert.equal(polygonUnion(masks).length,1,'The shared-edge fused masks must form a complete union');
  assert(contains(result,2375,925));assert(!contains(result,2399,934.9));assert(area(result)<area(subject)-50);
  for(let y=920.137;y<942;y+=.7)for(let x=2378.183;x<2410;x+=.7)assert.equal(contains(result,x,y),!contains(masks,x,y),'No native mask can be skipped during recovery');
  const tiny=rect(2500,920,2500.000001,921),withThin=polygonUnion([...masks,tiny]);
  assert(contains(withThin,2500.0000005,920.5),'Numerical recovery must retain a 1e-6-wide isolated plot');
  assert.deepEqual(masks,before,'Numerical recovery may not quantize source objects in place');
});
