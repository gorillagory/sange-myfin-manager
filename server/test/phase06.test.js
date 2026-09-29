import test from "node:test";
import assert from "node:assert/strict";
import { normalizeHostname,hostAllowed } from "../src/tenancy.js";
import { generatePosCode,protectPosCode } from "../src/pos-auth.js";
import { permissionsFor } from "../../src/domain/permissions.js";
import { createSale,cartItem } from "../../src/domain/pos.js";
import { sale as saleSchema,parse } from "../src/validation.js";
import { publicTransaction } from "../src/access.js";

test("tenant hosts are normalized and wildcard matching does not include the apex",()=>{
  assert.equal(normalizeHostname("BFSB-BALI.FINN3.COM:443"),"bfsb-bali.finn3.com");
  assert.equal(normalizeHostname("bad_host.finn3.com"),"");
  assert.equal(hostAllowed("bfsb-bali.finn3.com",["*.finn3.com"]),true);
  assert.equal(hostAllowed("finn3.com",["*.finn3.com"]),false);
  assert.equal(hostAllowed("evilfinn3.com",["*.finn3.com"]),false);
});

test("six-digit codes use company-scoped lookup and salted slow verifiers",async()=>{
  const options={codeSecret:"x".repeat(64)},code="012345";
  const first=await protectPosCode(options,"company-a",code,"a".repeat(32));
  const second=await protectPosCode(options,"company-a",code,"b".repeat(32));
  const other=await protectPosCode(options,"company-b",code,"a".repeat(32));
  assert.equal(first.lookupDigest,second.lookupDigest);
  assert.notEqual(first.verifier,second.verifier);
  assert.notEqual(first.lookupDigest,other.lookupDigest);
  assert.match(generatePosCode(),/^\d{6}$/);
  await assert.rejects(protectPosCode(options,"company-a","12345"),/invalid_input/);
});

test("role capabilities enforce the approved report and settings boundaries",()=>{
  const superAdmin=permissionsFor({role:"super_admin"}),owner=permissionsFor({role:"workspace_owner"}),manager=permissionsFor({role:"manager"}),operator=permissionsFor({role:"operator"});
  assert.equal(superAdmin.owner,true);assert.equal(owner.owner,true);
  assert.equal(manager.financialReports,true);assert.equal(manager.costsRead,false);assert.equal(manager.integrationSettingsWrite,false);
  assert.equal(operator.checkout,true);assert.equal(operator.expensesCreate,true);assert.equal(operator.inventoryTransact,true);
  assert.equal(operator.expensesWrite,false);assert.equal(operator.financialReports,false);assert.equal(operator.deviceSettingsWrite,true);assert.equal(operator.companyWrite,false);
});

test("sale validation accepts rounded v3 and legacy v2 receipts while projections retain the audit fields",()=>{
  const product={id:"rounding-product",name:"Counter item",price:19.93,sku:"ROUND-1"},company={id:"rounding-company",name:"Counter",preferences:{currency:"RM",taxRate:0}},user={uid:"rounding-operator",username:"Operator"};
  const current=createSale({id:"rounding-sale",items:[cartItem(product)],company,user,method:"Cash",received:20});
  assert.equal(parse(saleSchema,current).schemaVersion,3);
  const projected=publicTransaction(current,{role:"operator"});assert.equal(projected.totalBeforeRounding,19.93);assert.equal(projected.rounding,.02);assert.equal(projected.total,19.95);
  const legacy={...current,schemaVersion:2,total:19.93,change:.07};delete legacy.totalBeforeRounding;delete legacy.rounding;assert.equal(parse(saleSchema,legacy).schemaVersion,2);
  assert.throws(()=>parse(saleSchema,{...current,rounding:.03}),/invalid_input/);
});
