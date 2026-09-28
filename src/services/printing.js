import {cents} from '../domain/pos';
import {jsPDF} from 'jspdf';
import QRCode from 'qrcode';
import JsBarcode from 'jsbarcode';
import {presentReceipt} from '../domain/documentPresentation';
import {downloadDocumentPdf} from './documentPdf';
import {safeFilename} from './download';
export async function codeImage(value,kind='qr') {
  if(!value)throw new Error('Add a SKU or barcode value to this item first.');
  if(kind==='qr')return QRCode.toDataURL(value,{width:600,margin:4,errorCorrectionLevel:'M'});
  if(!/^[\x20-\x7E]{1,64}$/.test(value))throw new Error('Code 128 supports up to 64 printable ASCII characters here. Use QR for this code.');
  const canvas=document.createElement('canvas');JsBarcode(canvas,value,{format:'CODE128',width:3,height:110,displayValue:false,margin:24});return canvas.toDataURL('image/png');
}
export async function labelPdf({name,code,price,kind,size,copies,currency}) {
  const sizes={'50x30':[50,30],'40x30':[40,30],'60x40':[60,40]},[w,h]=sizes[size]||sizes['50x30'];
  if(!Number.isInteger(Number(copies))||copies<1||copies>100)throw new Error('Choose 1–100 labels.');
  // Long 1D codes need wider media for reliable scanning. QR is a safer fit.
  if(kind==='barcode'&&code.length>(w===40?12:18))throw new Error('Use QR for this long code or choose a wider sticker size.');
  const img=await codeImage(code,kind),pdf=new jsPDF({unit:'mm',format:[w,h],orientation:'landscape',compress:true});
  for(let i=0;i<copies;i++){
    if(i)pdf.addPage([w,h],'landscape');pdf.setFontSize(8);
    const title=pdf.splitTextToSize(name,w-5).slice(0,2);pdf.text(title,2.5,4);
    const top=title.length===2?9:6, bottom=h-7, imageHeight=bottom-top;
    if(kind==='qr')pdf.addImage(img,'PNG',2,top,imageHeight,imageHeight);
    else pdf.addImage(img,'PNG',2,top,w-4,imageHeight);
    if(kind==='qr'){pdf.setFontSize(7);pdf.text(pdf.splitTextToSize(`${currency} ${(cents(price)/100).toFixed(2)}`,w-imageHeight-5),imageHeight+3,top+5);}
    pdf.setFontSize(6);const codeSize=Math.min(6,6*(w-4)/Math.max(pdf.getTextWidth(code),w-4));pdf.setFontSize(codeSize);pdf.text(code,w/2,h-4,{align:'center'});
    if(kind==='barcode'){pdf.setFontSize(6);pdf.text(`${currency} ${(cents(price)/100).toFixed(2)}`,w/2,h-1.5,{align:'center'});}
  }
  return pdf;
}
export function downloadReceiptPdf(sale,width='80') {
  return downloadDocumentPdf(presentReceipt(sale),{paperWidth:width});
}
