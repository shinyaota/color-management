import { rgbToLab } from './color.js';

export const parsePaletteCsv = async (file) => {
  const text = await file.text();
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length);
  if (!lines.length) return [];

  const header = lines[0].split(',').map((s) => s.trim().toLowerCase());
  const rows = lines.slice(1);

  const hasLab = header.includes('lab_l') || header.includes('l');
  const hasRgb = header.includes('r') && header.includes('g') && header.includes('b');
  const nameIndex = header.indexOf('name');

  const getIndex = (key) => header.indexOf(key);

  const palette = [];
  for (const row of rows) {
    const cols = row.split(',').map((s) => s.trim());
    if (!cols.length) continue;
    const name = nameIndex >= 0 ? cols[nameIndex] : `Color ${palette.length + 1}`;

    if (hasLab) {
      const lIndex = getIndex('lab_l') >= 0 ? getIndex('lab_l') : getIndex('l');
      const aIndex = getIndex('lab_a') >= 0 ? getIndex('lab_a') : getIndex('a');
      const bIndex = getIndex('lab_b') >= 0 ? getIndex('lab_b') : getIndex('b');
      if (lIndex < 0 || aIndex < 0 || bIndex < 0) continue;
      palette.push({
        name,
        lab: {
          L: parseFloat(cols[lIndex]),
          a: parseFloat(cols[aIndex]),
          b: parseFloat(cols[bIndex])
        }
      });
      continue;
    }

    if (hasRgb) {
      const rIndex = getIndex('r');
      const gIndex = getIndex('g');
      const bIndex = getIndex('b');
      const r = parseFloat(cols[rIndex]);
      const g = parseFloat(cols[gIndex]);
      const b = parseFloat(cols[bIndex]);
      const lab = rgbToLab(r, g, b);
      palette.push({ name, lab });
    }
  }

  return palette.filter((item) =>
    Number.isFinite(item.lab?.L) && Number.isFinite(item.lab?.a) && Number.isFinite(item.lab?.b)
  );
};

export const buildCsv = (rows) => {
  if (!rows.length) return '';
  const header = Object.keys(rows[0]);
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(header.map((key) => row[key]).join(','));
  }
  return lines.join('\n');
};

export const summarizePalette = (palette) =>
  palette.map((item) => ({
    name: item.name,
    labL: item.lab.L,
    labA: item.lab.a,
    labB: item.lab.b
  }));
