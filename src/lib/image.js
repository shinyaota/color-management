export const loadImageFromFile = (file) => {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };
    img.src = url;
  });
};

export const drawImageToCanvas = (img, maxSize = null) => {
  const canvas = document.createElement('canvas');
  let width = img.width;
  let height = img.height;

  if (maxSize) {
    const scale = Math.min(1, maxSize / Math.max(width, height));
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, width, height);

  return { canvas, ctx, width, height };
};

export const getImageDataFromFile = async (file, maxSize = null) => {
  const img = await loadImageFromFile(file);
  const { canvas, ctx, width, height } = drawImageToCanvas(img, maxSize);
  const imageData = ctx.getImageData(0, 0, width, height);
  return { imageData, width, height, canvas, ctx };
};

export const canvasToBlob = (canvas, type = 'image/jpeg', quality = 0.92) => {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
};

export const resizeFileToBlob = async (file, maxSize, type = 'image/jpeg', quality = 0.92) => {
  const img = await loadImageFromFile(file);
  const { canvas } = drawImageToCanvas(img, maxSize);
  return canvasToBlob(canvas, type, quality);
};

export const blobToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Failed to convert blob to base64.'));
        return;
      }
      const [, base64] = result.split(',', 2);
      resolve(base64 ?? '');
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob.'));
    reader.readAsDataURL(blob);
  });

export const base64ToBlob = (base64, type = 'image/jpeg') => {
  const binary = atob(base64);
  const len = binary.length;
  const buffer = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    buffer[i] = binary.charCodeAt(i);
  }
  return new Blob([buffer], { type });
};
