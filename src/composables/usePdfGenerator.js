import html2pdf from 'html2pdf.js';
import { nextTick } from 'vue';

export function usePdfGenerator() {
    async function generatePdf(transaction, elementId, fileName, callback) {
        window.scrollTo(0, 0);
        await nextTick();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const element = document.getElementById(elementId);
        if (!element) throw new Error('The document preview is unavailable. Open it again and retry.');
        await document.fonts?.ready;
        await Promise.allSettled([...element.querySelectorAll('img')].map(img => img.decode()));
        await html2pdf().set({
            margin: 15, filename: fileName,
            image: { type: 'jpeg', quality: 0.98 },
            html2canvas: { scale: 2, useCORS: true, scrollY: 0, backgroundColor: '#ffffff' },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
        }).from(element).save();
        callback?.();
    }
    return { generatePdf };
}
