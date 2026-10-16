import {cents} from '../domain/pos.js';
import {jsPDF} from 'jspdf';
import QRCode from 'qrcode';
import JsBarcode from 'jsbarcode';
import {presentReceipt} from '../domain/documentPresentation.js';
import {downloadDocumentPdf} from './documentPdf.js';
import {safeFilename} from './download.js';
export async function codeImage(value,kind='qr') {
  if(!value)throw new Error('Add a SKU or barcode value to this item first.');
  if(kind==='qr')return QRCode.toDataURL(value,{width:600,margin:4,errorCorrectionLevel:'M'});
  if(!/^[\x20-\x7E]{1,64}$/.test(value))throw new Error('Code 128 supports up to 64 printable ASCII characters here. Use QR for this code.');
  const canvas=document.createElement('canvas');JsBarcode(canvas,value,{format:'CODE128',width:3,height:110,displayValue:false,margin:24});return canvas.toDataURL('image/png');
}
export const LABEL_DESIGNS=Object.freeze([
  {id:'classic',label:'Classic',description:'Name above code, balanced for stock and retail.'},
  {id:'retail',label:'Retail price',description:'Prominent price with a branded header.'},
  {id:'compact',label:'Compact',description:'Largest possible scannable code.'},
]);
export function normalizeLabelOptions(raw={}){
  const design=LABEL_DESIGNS.some(item=>item.id===raw.design)?raw.design:'classic';
  const accent=/^#[0-9a-f]{6}$/i.test(String(raw.accent||''))?String(raw.accent).toUpperCase():'#245C49';
  const subtitle=String(raw.subtitle||'').replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,60);
  return {design,accent,subtitle,showPrice:raw.showPrice!==false,showName:raw.showName!==false};
}
const colorChannels=value=>[1,3,5].map(index=>parseInt(value.slice(index,index+2),16));
export async function labelPdf({name,code,price,kind,size,copies,currency,showPrice=true,showName=true,design='classic',accent='#245C49',subtitle=''}) {
  const sizes={'50x30':[50,30],'40x30':[40,30],'60x40':[60,40]},[w,h]=sizes[size]||sizes['50x30'];
  if(!Number.isInteger(Number(copies))||copies<1||copies>100)throw new Error('Choose 1–100 labels.');
  // Long 1D codes need wider media for reliable scanning. QR is a safer fit.
  if(kind==='barcode'&&code.length>(w===40?12:18))throw new Error('Use QR for this long code or choose a wider sticker size.');
  const options=normalizeLabelOptions({design,accent,subtitle,showPrice,showName});
  const img=await codeImage(code,kind),pdf=new jsPDF({unit:'mm',format:[w,h],orientation:'landscape',compress:true});
  for(let i=0;i<copies;i++){
    if(i)pdf.addPage([w,h],'landscape');
    const priceText=`${currency} ${(cents(price)/100).toFixed(2)}`.trim(),[r,g,b]=colorChannels(options.accent);
    if(options.design==='retail'){
      pdf.setFillColor(r,g,b);pdf.rect(0,0,w,7,'F');pdf.setTextColor(255,255,255);pdf.setFont('helvetica','bold');pdf.setFontSize(7);
      if(options.showName)pdf.text(pdf.splitTextToSize(name,w-5).slice(0,1),2.5,4.6);
      pdf.setTextColor(20,28,26);pdf.setFont('helvetica','normal');
      const top=8.5,imageSize=Math.min(h-top-3,w*.48);
      if(kind==='qr')pdf.addImage(img,'PNG',2,top,imageSize,imageSize);else pdf.addImage(img,'PNG',2,top,w-4,h-top-6);
      if(kind==='qr'){
        if(options.showPrice){pdf.setFont('helvetica','bold');pdf.setFontSize(w>=50?12:9);pdf.text(priceText,imageSize+3,top+6);}
        if(options.subtitle){pdf.setFont('helvetica','normal');pdf.setFontSize(5.5);pdf.text(pdf.splitTextToSize(options.subtitle,w-imageSize-6).slice(0,3),imageSize+3,top+(options.showPrice?10:4));}
      }
      pdf.setFont('helvetica','normal');pdf.setFontSize(5.5);pdf.text(code,w/2,h-1.8,{align:'center'});
      if(kind==='barcode'&&options.showPrice){pdf.setFillColor(255,255,255);pdf.rect(w-18,h-6,16,4,'F');pdf.setFont('helvetica','bold');pdf.setFontSize(7);pdf.text(priceText,w-2,h-3,{align:'right'});}
    }else{
      const compact=options.design==='compact',title=options.showName?pdf.splitTextToSize(name,w-5).slice(0,compact?1:2):[];
      pdf.setTextColor(20,28,26);pdf.setFont('helvetica','bold');pdf.setFontSize(compact?6.5:8);if(title.length)pdf.text(title,2.5,4);
      pdf.setFont('helvetica','normal');const top=title.length?(title.length===2?9:6):2,bottom=h-(options.subtitle?8:6),imageHeight=bottom-top;
      if(kind==='qr')pdf.addImage(img,'PNG',2,top,imageHeight,imageHeight);else pdf.addImage(img,'PNG',2,top,w-4,imageHeight);
      if(kind==='qr'&&options.showPrice){pdf.setFont('helvetica','bold');pdf.setFontSize(compact?8:7);pdf.text(pdf.splitTextToSize(priceText,w-imageHeight-5),imageHeight+3,top+5);}
      if(options.subtitle){pdf.setFont('helvetica','normal');pdf.setFontSize(5.5);pdf.text(pdf.splitTextToSize(options.subtitle,w-5).slice(0,1),2.5,h-5.3);}
      pdf.setFont('helvetica','normal');pdf.setFontSize(6);const codeSize=Math.min(6,6*(w-4)/Math.max(pdf.getTextWidth(code),w-4));pdf.setFontSize(codeSize);pdf.text(code,w/2,h-2.3,{align:'center'});
      if(kind==='barcode'&&options.showPrice){pdf.setFont('helvetica','bold');pdf.setFontSize(6);pdf.text(priceText,w-2,h-(options.subtitle?5.3:1.5),{align:'right'});}
    }
  }
  return pdf;
}
export function downloadReceiptPdf(sale,width='80') {
  return downloadDocumentPdf(presentReceipt(sale),{paperWidth:width});
}
