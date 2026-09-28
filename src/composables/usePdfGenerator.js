import { downloadDocumentPdf } from '../services/documentPdf';
export function usePdfGenerator() {
  return { generatePdf: document => downloadDocumentPdf(document) };
}
