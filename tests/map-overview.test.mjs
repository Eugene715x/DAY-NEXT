import test from 'node:test';
import assert from 'node:assert/strict';
import { createOverviewMarkers, OVERVIEW_MAX_ZOOM } from '../map-overview.js';
import map from '../maps/usa.js';

test('overview markers use real place tags and deduplicate facets instead of promoting shops to towns', () => {
  const town = {id:'node-1',name:'Town',x:10,y:10,tags:{place:'town',name:'Town'}};
  const world = {geographic:true,width:100,height:100,pois:[town,{id:'shop',kind:'town',name:'Shop',x:20,y:20,tags:{shop:'convenience'}}],details:[{...town,points:[{x:10,y:10}]}]};
  const before=structuredClone(world), markers=createOverviewMarkers(world);
  assert.deepEqual(markers.map(m=>m.sourceId),['node-1']);
  markers[0].tags.place='changed'; assert.deepEqual(world,before);
  assert(OVERVIEW_MAX_ZOOM>0 && OVERVIEW_MAX_ZOOM<2);
});

test('airport markers stay inside actual concave grounds and avoid inner holes', () => {
  const ring=[{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100},{x:0,y:0}];
  const hole=[{x:20,y:20},{x:80,y:20},{x:80,y:80},{x:20,y:80},{x:20,y:20}];
  const [airport]=createOverviewMarkers({geographic:true,width:100,height:100,details:[{id:'way-2',geometry:'polygon',name:'Airport',tags:{aeroway:'aerodrome'},rings:[ring,hole]}]});
  assert.equal(airport.kind,'airport');
  assert(airport.x>0 && airport.x<100 && airport.y>0 && airport.y<100);
  assert(!(airport.x>20 && airport.x<80 && airport.y>20 && airport.y<80));
  assert.equal(createOverviewMarkers({width:100,height:100,pois:[]}).length,0);
});

test('Nevada overview includes Beatty, abandoned Rhyolite and the mapped airport without administrative polygons', () => {
  const markers=createOverviewMarkers(map);
  assert(markers.some(m=>m.name==='Beatty' && m.kind==='settlement'));
  assert(markers.some(m=>m.name==='Rhyolite' && m.kind==='settlement'));
  assert(markers.some(m=>m.name==='Beatty Airport' && m.kind==='airport'));
  assert(markers.every(m=>!m.tags.boundary && m.name!=='Arco'));
});
