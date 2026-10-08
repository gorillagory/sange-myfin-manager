import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compileScript, compileStyle, compileTemplate, parse } from '@vue/compiler-sfc';

const filename=new URL('../src/components/dashboard/ProcurementTab.vue',import.meta.url);
const source=await readFile(filename,'utf8');

test('ProcurementTab script, template and responsive styles compile',()=>{
  const parsed=parse(source,{filename:filename.pathname});
  assert.deepEqual(parsed.errors,[]);
  const script=compileScript(parsed.descriptor,{id:'procurement-tab-test'});
  const template=compileTemplate({source:parsed.descriptor.template.content,filename:filename.pathname,
    id:'procurement-tab-test',compilerOptions:{bindingMetadata:script.bindings}});
  assert.deepEqual(template.errors,[]);
  for(const style of parsed.descriptor.styles){
    const result=compileStyle({source:style.content,filename:filename.pathname,id:'procurement-tab-test',scoped:style.scoped});
    assert.deepEqual(result.errors,[]);
  }
});

test('ProcurementTab follows procurement API access and payload boundaries',()=>{
  assert.match(source,/const owner = computed\(\(\) => Store\.can\('costsRead'\)\)/);
  assert.match(source,/tab==='orders'&&owner/);
  assert.match(source,/tab==='valuation'&&owner/);
  assert.match(source,/supplierId:form\.type==='supplier_barcode'\?form\.supplierId:''/);
  assert.match(source,/packagingId:form\.packagingId\|\|''/);
  assert.match(source,/unitPriceSen:Math\.round\(Number\(line\.unitPrice\) \* 100\)/);
  assert.match(source,/receivedAt:receivedAt\.toISOString\(\)/);
  assert.doesNotMatch(source,/new Date\(\)\.toISOString\(\)\.slice\(0,16\)/);
});

test('ProcurementTab clears tenant data and blocks stale privileged tabs on context changes',()=>{
  assert.match(source,/queue\.value=\[\];alerts\.value=\[\];orders\.value=\[\];valuation\.value=\[\];identifiers\.value=\[\]/);
  assert.match(source,/!owner\.value && \['orders','valuation'\]\.includes\(tab\.value\)/);
  assert.match(source,/Purchasing requires a live connection/);
  assert.match(source,/@media\(max-width:620px\)/);
});
