import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,describe,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({search:'',error:null as null|{message:string},data:{} as Record<string,unknown>}));
vi.mock('@paperclipai/plugin-sdk/ui',()=>({
 useHostLocation:()=>({pathname:'/BRO/inventory',search:state.search,hash:''}),
 useHostNavigation:()=>({linkProps:(path:string)=>({href:`/BRO${path}`})}),
 usePluginAction:()=>vi.fn(),
 usePluginData:()=>({data:state.data,error:state.error,loading:false,refresh:vi.fn()}),
}));
import {InventoryPage,InventoryDashboard,InventorySidebar} from '../src/ui/index.js';
describe('native UI rendering',()=>{
 beforeEach(()=>{state.search='';state.error=null;state.data={parts:[],counts:[],items:[],orders:[],history:[],shortCloses:[],settings:{approvalMode:'all'},revision:'0'};});
 it('renders stock quantities and metadata without exposing an editable on-hand field',()=>{
  state.data.parts=[{partId:'synthetic',vendor:'test',vendor_part_number:'PART',on_hand:'21',on_order:'0',committed:'2',available:'19',lastCost:'2.50',averageCost:'2.20',lastOrdered:'2026-01-01',active:true}];
  const html=renderToStaticMarkup(React.createElement(InventoryPage));
  for(const value of ['Physical Counts','Receiving','Needs Review','On hand','On order','Committed','Available','Last cost','Average cost','21','19'])expect(html).toContain(value);
  expect(html).not.toContain('name="onHand"');
 });
 it.each(['counts','receiving','review','settings'])('opens the %s workflow from a dashboard link',page=>{
  state.search=`?page=${page}`;const html=renderToStaticMarkup(React.createElement(InventoryPage));
  const expected={counts:'Preview batch',receiving:'Receipt history',review:'Count submissions',settings:'Save settings'}[page];expect(html).toContain(expected);
 });
 it('keeps linked alerts inside the active host company',()=>{
  state.data={lowStock:3,pendingCounts:2,pendingReviews:1,negativeStock:0};
  const dashboard=renderToStaticMarkup(React.createElement(InventoryDashboard));
  expect(dashboard).toContain('/BRO/inventory?lowStock=true');expect(dashboard).toContain('/BRO/inventory?page=counts');expect(dashboard).toContain('/BRO/inventory?page=review');
  expect(renderToStaticMarkup(React.createElement(InventorySidebar))).toContain('/BRO/inventory');
 });
 it('escapes vendor content and displays host bridge errors',()=>{
  state.error={message:'Access denied'};state.data.parts=[{partId:'synthetic',vendor:'<script>alert(1)</script>',vendor_part_number:'PART'}];
  const html=renderToStaticMarkup(React.createElement(InventoryPage));expect(html).toContain('role="alert"');expect(html).toContain('Access denied');expect(html).not.toContain('<script>');
 });
});
