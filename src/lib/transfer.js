import { rgbToLab, labToRgb, clampLab, blend } from './color.js';

export const applyReinhardTransfer = ({
  imageData,
  referenceStats,
  targetStats,
  strength = 1,
  mode = 'full'
}) => {
  const data = imageData.data;
  const refMean = referenceStats.mean;
  const refStd = referenceStats.std;
  const tgtMean = targetStats.mean;
  const tgtStd = targetStats.std;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const lab = rgbToLab(r, g, b);
    let L = lab.L;
    let a = lab.a;
    let bLab = lab.b;

    if (mode === 'full' || mode === 'luminance') {
      L = ((L - tgtMean.L) * (refStd.L / tgtStd.L)) + refMean.L;
    }
    if (mode === 'full' || mode === 'chromatic') {
      a = ((a - tgtMean.a) * (refStd.a / tgtStd.a)) + refMean.a;
      bLab = ((bLab - tgtMean.b) * (refStd.b / tgtStd.b)) + refMean.b;
    }

    const clamped = clampLab({ L, a, b: bLab });
    const rgb = labToRgb(clamped.L, clamped.a, clamped.b);

    data[i] = blend(r, rgb.r, strength);
    data[i + 1] = blend(g, rgb.g, strength);
    data[i + 2] = blend(b, rgb.b, strength);
  }

  return imageData;
};

export const applyLabShift = (imageData, shift, strength = 1) => {
  if (!shift) return imageData;
  const shiftL = shift.L ?? 0;
  const shiftA = shift.a ?? 0;
  const shiftB = shift.b ?? 0;
  if (shiftL === 0 && shiftA === 0 && shiftB === 0) return imageData;

  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const lab = rgbToLab(r, g, b);
    const shifted = clampLab({
      L: lab.L + shiftL,
      a: lab.a + shiftA,
      b: lab.b + shiftB
    });
    const rgb = labToRgb(shifted.L, shifted.a, shifted.b);

    data[i] = blend(r, rgb.r, strength);
    data[i + 1] = blend(g, rgb.g, strength);
    data[i + 2] = blend(b, rgb.b, strength);
  }

  return imageData;
};
