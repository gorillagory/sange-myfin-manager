import html2pdf from 'html2pdf.js';
import { nextTick } from 'vue';

export function usePdfGenerator() {
    
    function generatePdf(transaction, elementId, fileName, callback) {
        window.scrollTo(0, 0); // Scroll top for capture

        nextTick(() => {
            setTimeout(() => {
                const element = document.getElementById(elementId);
                
                if (!element) return;

                const opt = {
                    margin: 15, // Standard A4 Margin (mm)
                    filename: fileName,
                    image: { type: 'jpeg', quality: 0.98 },
                    html2canvas: { scale: 2, useCORS: true, scrollY: 0 },
                    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
                };

                html2pdf().set(opt).from(element).save()
                    .then(() => {
                        if (callback) callback();
                    });

            }, 800); 
        });
    }

    return { generatePdf };
}