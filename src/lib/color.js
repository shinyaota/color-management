const D65 = {
  x: 0.95047,
  y: 1.0,
  z: 1.08883
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const srgbToLinear = (value) => {
  if (value <= 0.04045) return value / 12.92;
  return Math.pow((value + 0.055) / 1.055, 2.4);
};

const linearToSrgb = (value) => {
  if (value <= 0.0031308) return 12.92 * value;
  return 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
};

const labPivot = (value) => {
  return value > 0.008856 ? Math.cbrt(value) : (7.787 * value) + 16 / 116;
};

const labPivotInv = (value) => {
  const cube = Math.pow(value, 3);
  return cube > 0.008856 ? cube : (value - 16 / 116) / 7.787;
};

export const rgbToLab = (r, g, b) => {
  const rn = srgbToLinear(r / 255);
  const gn = srgbToLinear(g / 255);
  const bn = srgbToLinear(b / 255);

  const x = rn * 0.4124564 + gn * 0.3575761 + bn * 0.1804375;
  const y = rn * 0.2126729 + gn * 0.7151522 + bn * 0.0721750;
  const z = rn * 0.0193339 + gn * 0.1191920 + bn * 0.9503041;

  const fx = labPivot(x / D65.x);
  const fy = labPivot(y / D65.y);
  const fz = labPivot(z / D65.z);

  const L = 116 * fy - 16;
  const a = 500 * (fx - fy);
  const bLab = 200 * (fy - fz);

  return { L, a, b: bLab };
};

export const labToRgb = (L, a, b) => {
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;

  const xr = labPivotInv(fx);
  const yr = labPivotInv(fy);
  const zr = labPivotInv(fz);

  const x = xr * D65.x;
  const y = yr * D65.y;
  const z = zr * D65.z;

  let r = x * 3.2404542 + y * -1.5371385 + z * -0.4985314;
  let g = x * -0.9692660 + y * 1.8760108 + z * 0.0415560;
  let bVal = x * 0.0556434 + y * -0.2040259 + z * 1.0572252;

  r = linearToSrgb(r);
  g = linearToSrgb(g);
  bVal = linearToSrgb(bVal);

  return {
    r: clamp(Math.round(r * 255), 0, 255),
    g: clamp(Math.round(g * 255), 0, 255),
    b: clamp(Math.round(bVal * 255), 0, 255)
  };
};

export const computeLabStats = (imageData, sampleStep = 4) => {
  const data = imageData.data;
  let count = 0;
  let sumL = 0;
  let sumA = 0;
  let sumB = 0;
  let sumL2 = 0;
  let sumA2 = 0;
  let sumB2 = 0;

  const stride = Math.max(1, sampleStep) * 4;

  for (let i = 0; i < data.length; i += stride) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const lab = rgbToLab(r, g, b);
    sumL += lab.L;
    sumA += lab.a;
    sumB += lab.b;
    sumL2 += lab.L * lab.L;
    sumA2 += lab.a * lab.a;
    sumB2 += lab.b * lab.b;
    count += 1;
  }

  const meanL = sumL / count;
  const meanA = sumA / count;
  const meanB = sumB / count;

  const varL = Math.max(0, sumL2 / count - meanL * meanL);
  const varA = Math.max(0, sumA2 / count - meanA * meanA);
  const varB = Math.max(0, sumB2 / count - meanB * meanB);

  return {
    mean: { L: meanL, a: meanA, b: meanB },
    std: {
      L: Math.sqrt(varL) || 1e-6,
      a: Math.sqrt(varA) || 1e-6,
      b: Math.sqrt(varB) || 1e-6
    }
  };
};

export const clampLab = (lab) => {
  return {
    L: clamp(lab.L, 0, 100),
    a: clamp(lab.a, -128, 127),
    b: clamp(lab.b, -128, 127)
  };
};

export const blend = (base, target, amount) => {
  return Math.round(base + (target - base) * amount);
};
