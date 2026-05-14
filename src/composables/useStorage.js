import { getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import jsQR from 'jsqr';
import QRCode from 'qrcode';

export function useStorage() {
    const storage = getStorage();

    /**
     * Uploads a file to Firebase Storage
     */
    const uploadFile = async (file, path) => {
        const fileRef = storageRef(storage, path);
        await uploadBytes(fileRef, file);
        const url = await getDownloadURL(fileRef);
        return { url, path: fileRef.fullPath };
    };

    /**
     * Deletes a file from Firebase Storage
     */
    const removeFile = async (path) => {
        if (!path) return;
        try {
            const fileRef = storageRef(storage, path);
            await deleteObject(fileRef);
        } catch (err) {
            console.warn("[Storage] File not found or already deleted", err);
        }
    };

    /**
     * Resizes an image using an HTML Canvas to prevent massive Base64 strings.
     */
    const optimizeImage = (file, isLogo = false) => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    const MAX_SIZE = 400;
                    let w = img.width, h = img.height;
                    
                    if (w > h) { if (w > MAX_SIZE) { h *= MAX_SIZE / w; w = MAX_SIZE; } } 
                    else { if (h > MAX_SIZE) { w *= MAX_SIZE / h; h = MAX_SIZE; } }
                    
                    canvas.width = w; canvas.height = h;
                    ctx.drawImage(img, 0, 0, w, h);
                    resolve(canvas.toDataURL(isLogo ? 'image/jpeg' : 'image/png', 0.8));
                };
                img.onerror = reject;
                img.src = e.target.result;
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    };

    /**
     * Reads an uploaded image, looks for a DuitNow/Payment QR, and generates a clean version.
     */
    const extractQRCode = (file) => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    const cvs = document.createElement('canvas');
                    const ctx = cvs.getContext('2d');
                    cvs.width = img.width; cvs.height = img.height;
                    ctx.drawImage(img, 0, 0);
                    
                    const code = jsQR(ctx.getImageData(0, 0, img.width, img.height).data, img.width, img.height);
                    if (code) {
                        QRCode.toDataURL(code.data, { width: 400, margin: 1 }, (err, url) => {
                            if (!err) resolve({ success: true, url });
                            else resolve({ success: false });
                        });
                    } else {
                        resolve({ success: false });
                    }
                };
                img.onerror = reject;
                img.src = e.target.result;
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    };

    return { uploadFile, removeFile, optimizeImage, extractQRCode };
}