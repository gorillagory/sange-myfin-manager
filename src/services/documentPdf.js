import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import { money } from '../domain/pos.js';
import { safeFilename } from './download.js';

const rgb = value => /^#[0-9a-f]{6}$/i.test(value || '') ? [1,3,5].map(offset=>parseInt(value.slice(offset,offset+2),16)) : [22,78,66];
const strings = (...values) => values.filter(value=>value !== undefined && value !== null && value !== '').map(String);
async function imageData(url) {
  if (!url) return null;
  try {
    const image = new Image(); image.crossOrigin = 'anonymous'; image.src = url; await image.decode();
    const canvas = document.createElement('canvas'); const ratio=Math.min(1,900/Math.max(image.naturalWidth,image.naturalHeight)); canvas.width=Math.max(1,Math.round(image.naturalWidth*ratio));canvas.height=Math.max(1,Math.round(image.naturalHeight*ratio));
    canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
    return {data:canvas.toDataURL('image/png'),ratio:image.naturalWidth/image.naturalHeight};
  } catch { return null; }
}
export async function createDocumentPdf(doc, options = {}) {
  if(doc.invalid)throw new Error('Complete the draft before creating its PDF.');
  const receipt = doc.format === 'receipt', width = receipt ? (String(options.paperWidth || doc.settings.paperWidth) === '58' ? 58 : 80) : 210;
  const pageHeight=receipt&&options._pageHeight?options._pageHeight:297;
  const pdf = new jsPDF({unit:'mm',format:receipt?[width,pageHeight]:'a4',orientation:'portrait',compress:true});
  const margin=receipt?4:14, usable=width-margin*2, bottom=receipt?10:18, accent=rgb(doc.settings.primaryColor), font=receipt?'courier':doc.settings.fontFamily==='serif'?'times':'helvetica', size=receipt?8:10;
  const logo=doc.settings.showLogo ? await imageData(doc.company.logo) : null;
  const qr=doc.settings.showPaymentQr ? await imageData(doc.company.qrCode) : null;
  let y=margin, first=true, requiredPageHeight=0;
  pdf.setFont(font,'normal');pdf.setFontSize(size);pdf.setTextColor(32,46,43);
  pdf.setFont(font,'bold');pdf.setFontSize(receipt?8:10);
  const headerLines=pdf.splitTextToSize(String(doc.company.name||'MyFin'),usable), headerStart=receipt?6:10, headerStep=receipt?3.5:4.2;
  const headerBottom=Math.max(receipt?17:24,headerStart+headerLines.length*headerStep+8);
  const runningHeader=()=>{pdf.setFont(font,'bold');pdf.setFontSize(receipt?8:10);headerLines.forEach((text,index)=>pdf.text(text,margin,headerStart+index*headerStep));pdf.setFont(font,'normal');pdf.setFontSize(receipt?7:8);pdf.text(String(doc.number||'Draft'),width-margin,headerBottom-4,{align:'right'});};
  function nextPage(){pdf.addPage(receipt?[width,pageHeight]:'a4','portrait');runningHeader();y=headerBottom;}
  function ensure(height){requiredPageHeight=Math.max(requiredPageHeight,y+height+bottom);if(y+height>pageHeight-bottom)nextPage();}
  function line(text,{bold=false,color=null,point=size,gap=1,x=margin,lineWidth=usable}={}){
    if(text===undefined||text===null||text==='')return;
    pdf.setFont(font,bold?'bold':'normal');pdf.setFontSize(point);pdf.setTextColor(...(color||[32,46,43]));
    const rows=pdf.splitTextToSize(String(text),lineWidth),height=point*.42;
    for(const row of rows){ensure(height+gap);pdf.setFont(font,bold?'bold':'normal');pdf.setFontSize(point);pdf.setTextColor(...(color||[32,46,43]));pdf.text(row,x,y+height);y+=height+gap;}
  }
  function section(title,text){if(!text)return;ensure(title?15:9);y+=title?5:3;line(title,{bold:true,color:accent,point:receipt?8:10});line(text,{point:size});}
  if(doc.pending)line('Payment recorded on this device · Awaiting server sync',{bold:true,point:receipt?8:10});
  if(doc.isDraft)line('DRAFT · Not issued',{bold:true,point:receipt?9:11});
  if(receipt){
  if(logo){const w=Math.min(receipt?Math.min(30,usable):35,(receipt?18:24)*logo.ratio),h=w/logo.ratio;pdf.addImage(logo.data,'PNG',margin,y,w,h);y+=h+4;}
  line(doc.company.name,{bold:true,point:receipt?12:18});
  for(const value of strings(doc.company.registration && 'Registration: '+doc.company.registration,doc.company.address,doc.company.phone,doc.company.email))line(value,{point:receipt?8:9});
  y+=5;line(doc.settings.labels.title,{bold:true,color:accent,point:receipt?12:22});line(doc.number||'Assigned when issued',{bold:true});
  if(doc.isPaid)line('PAID',{bold:true,color:[23,96,68]});
  else if(doc.status&&!doc.isDraft)line(doc.status);
  y+=3;
  line((receipt?'Date & time: ':'Issue date: ')+(doc.displayDate||String(doc.date||'').slice(0,10)));
  if(doc.dueDate)line('Payment due: '+doc.dueDate);
  if(doc.validUntil)line('Quote valid until: '+doc.validUntil);
  if(doc.project)line('Project: '+doc.project);
  if(doc.cashierName)line('Cashier: '+doc.cashierName);
  y+=4;line(doc.settings.labels.billTo,{bold:true,color:accent});for(const value of strings(doc.customer.name||'Walk-in customer',doc.customer.registration,doc.customer.address,doc.customer.email,doc.customer.phone))line(value);
  }else{
    const top=y, leftWidth=usable*.53, rightX=margin+usable*.59, rightWidth=usable*.41;
    if(logo){const w=Math.min(35,24*logo.ratio),h=w/logo.ratio;pdf.addImage(logo.data,'PNG',margin,y,w,h);y+=h+3;}
    line(doc.company.name,{bold:true,point:16,lineWidth:leftWidth});
    for(const value of strings(doc.company.registration&&'Registration: '+doc.company.registration,doc.company.address,doc.company.phone,doc.company.email))line(value,{point:8.5,gap:.5,lineWidth:leftWidth});
    const merchantBottom=y;y=top;
    line(doc.settings.labels.title,{bold:true,color:accent,point:22,x:rightX,lineWidth:rightWidth});
    line(doc.number||'Assigned when issued',{bold:true,x:rightX,lineWidth:rightWidth});
    if(doc.isPaid)line('PAID',{bold:true,color:[23,96,68],x:rightX,lineWidth:rightWidth});else if(doc.status&&!doc.isDraft)line(doc.status,{x:rightX,lineWidth:rightWidth});
    y+=3;line('Issue date: '+String(doc.date||'').slice(0,10),{point:9,x:rightX,lineWidth:rightWidth});
    if(doc.dueDate)line('Payment due: '+doc.dueDate,{point:9,x:rightX,lineWidth:rightWidth});
    if(doc.validUntil)line('Quote valid until: '+doc.validUntil,{point:9,x:rightX,lineWidth:rightWidth});
    y=Math.max(y,merchantBottom)+8;pdf.setDrawColor(...accent);pdf.setLineWidth(doc.settings.layout==='modern'?1:.3);pdf.line(margin,y-4,width-margin,y-4);
    line(doc.settings.labels.billTo,{bold:true,color:accent,point:9});
    for(const value of strings(doc.customer.name||'Walk-in customer',doc.customer.registration,doc.customer.address,doc.customer.email,doc.customer.phone))line(value,{point:9,gap:.5});
    if(doc.project)line('Project: '+doc.project,{point:9});
  }
  y+=6;ensure(24);
  const currency=doc.currency||'RM', amount=value=>money(value||0,currency);
  autoTable(pdf,{
    startY:y,margin:{left:margin,right:margin,top:headerBottom,bottom},
    head:receipt?[['Description','Amount']]:[['Description','Qty','Unit price','Amount']],
    body:doc.items.map(item=>receipt?[item.desc+'\n'+item.qty+' '+(item.unit||'')+' × '+amount(item.price),amount(item.amount)]:[item.desc+(item.unit?'\n'+item.unit:''),String(item.qty),amount(item.price),amount(item.amount)]),
    theme:doc.settings.layout==='clean'?'plain':'striped',showHead:'everyPage',rowPageBreak:'avoid',
    styles:{font,fontSize:receipt?7:9,cellPadding:receipt?1:2.5,overflow:'linebreak',textColor:[32,46,43]},
    headStyles:{fontStyle:'bold',fillColor:doc.settings.layout==='clean'?[240,244,240]:accent,textColor:doc.settings.layout==='clean'?accent:[255,255,255]},
    columnStyles:receipt?{0:{cellWidth:usable*.66},1:{cellWidth:usable*.34,halign:'right'}}:{0:{cellWidth:usable*.49},1:{cellWidth:usable*.1,halign:'right'},2:{cellWidth:usable*.205,halign:'right'},3:{cellWidth:usable*.205,halign:'right'}},
    didDrawPage(data){if(!first)runningHeader();first=false;},
  });
  y=pdf.lastAutoTable.finalY+6;
  const totals=[['Subtotal',doc.subtotal],...(doc.discountAmount?[[`Discount (${doc.discount}%)`,-doc.discountAmount]]:[]),...(doc.tax||doc.taxRate?[[`Tax (${doc.taxRate}%)`,doc.tax]]:[]),[doc.settings.labels.total,doc.total],...(doc.paymentMethod?[['Payment',doc.paymentMethod]]:[]),...(doc.received!=null?[['Received',doc.received]]:[]),...(doc.change!=null?[['Change',doc.change]]:[]),...(!receipt&&doc.amountPaid?[['Payments recorded',doc.amountPaid]]:[]),...(!receipt&&doc.kind==='Invoice'&&!doc.isDraft&&doc.balance!=null?[['Balance due',doc.balance]]:[])];
  for(const [label,value] of totals)line(label+': '+(typeof value==='number'?amount(value):value),{bold:label===doc.settings.labels.total,point:label===doc.settings.labels.total?(receipt?10:12):size});
  section('Payment instructions',doc.paymentInstructions);
  if(qr){ensure(34);pdf.addImage(qr.data,'PNG',margin,y+3,28,28);y+=34;}
  section('Notes',doc.notes);section(doc.kind==='Quote'?'Terms & acceptance':'Terms',doc.terms);
  if(doc.settings.showSignature){ensure(24);y+=17;pdf.setDrawColor(150,166,156);pdf.line(margin,y,margin+Math.min(65,usable),y);y+=2;line(doc.settings.signatureLabel||'Authorized signature',{point:receipt?7:9});}
  section('',doc.footer);
  const pages=pdf.getNumberOfPages();
  // Render short thermal rolls again at their measured length so PDF coordinates remain correct.
  const measuredHeight=Math.max(80,Math.ceil(Math.max(y+bottom+4,requiredPageHeight+1)));
  if(receipt&&!options._pageHeight&&pages===1&&measuredHeight<pageHeight){return createDocumentPdf(doc,{...options,_pageHeight:measuredHeight});}
  for(let page=1;page<=pages;page++){pdf.setPage(page);pdf.setFont(font,'normal');pdf.setFontSize(receipt?6:8);pdf.setTextColor(110,123,116);pdf.text(`${doc.number||'Draft'} · ${page}/${pages}`,width-margin,pageHeight-(receipt?4:8),{align:'right'});}
  return pdf;
}
export async function downloadDocumentPdf(doc, options = {}) {
  const pdf = await createDocumentPdf(doc,options);
  pdf.save(safeFilename(doc.number || 'draft-'+doc.kind.toLowerCase())+'.pdf');
  return pdf;
}
