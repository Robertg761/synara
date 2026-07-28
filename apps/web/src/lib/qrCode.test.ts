// FILE: qrCode.test.ts
// Purpose: Verifies QR encoding, layout, masking, and SVG path generation.
// Layer: Web utility test
// Exports: None

import { describe, expect, it } from "vitest";

import { encodeQrCode, qrCodeToSvgPath, type QrCodeMatrix } from "./qrCode";

function expectFinder(matrix: QrCodeMatrix, originX: number, originY: number): void {
  for (let y = 0; y < 7; y += 1) {
    for (let x = 0; x < 7; x += 1) {
      const distance = Math.max(Math.abs(x - 3), Math.abs(y - 3));
      expect(matrix.modules[originY + y]?.[originX + x]).toBe(distance === 3 || distance <= 1);
    }
  }

  const separatorX = originX === 0 ? 7 : originX - 1;
  const separatorY = originY === 0 ? 7 : originY - 1;
  const separatorStartX = originX === 0 ? originX : originX - 1;
  const separatorStartY = originY === 0 ? originY : originY - 1;
  for (let offset = 0; offset < 8; offset += 1) {
    expect(matrix.modules[separatorY]?.[separatorStartX + offset]).toBe(false);
    expect(matrix.modules[separatorStartY + offset]?.[separatorX]).toBe(false);
  }
}

function makeVersionOneFunctionMap(size: number): boolean[][] {
  const result = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const mark = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < size && y < size) {
      const row = result[y];
      if (row !== undefined) {
        row[x] = true;
      }
    }
  };
  for (let index = 0; index < size; index += 1) {
    mark(6, index);
    mark(index, 6);
  }
  const finderCenters: ReadonlyArray<readonly [number, number]> = [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ];
  for (const [centerX, centerY] of finderCenters) {
    for (let deltaY = -4; deltaY <= 4; deltaY += 1) {
      for (let deltaX = -4; deltaX <= 4; deltaX += 1) {
        mark(centerX + deltaX, centerY + deltaY);
      }
    }
  }
  for (let index = 0; index <= 5; index += 1) {
    mark(8, index);
  }
  mark(8, 7);
  mark(8, 8);
  mark(7, 8);
  for (let index = 9; index < 15; index += 1) {
    mark(14 - index, 8);
  }
  for (let index = 0; index < 8; index += 1) {
    mark(size - 1 - index, 8);
  }
  for (let index = 8; index < 15; index += 1) {
    mark(8, size - 15 + index);
  }
  mark(8, size - 8);
  return result;
}

function formatBitsForMask(mask: number): number {
  const data = mask;
  let remainder = data;
  for (let bit = 0; bit < 10; bit += 1) {
    remainder = (remainder << 1) ^ (((remainder >>> 9) & 1) * 0x537);
  }
  return ((data << 10) | remainder) ^ 0x5412;
}

function readVersionOneDataCodewords(matrix: QrCodeMatrix): number[] {
  let formatBits = 0;
  for (let index = 0; index <= 5; index += 1) {
    formatBits |= (matrix.modules[index]?.[8] ? 1 : 0) << index;
  }
  formatBits |= (matrix.modules[7]?.[8] ? 1 : 0) << 6;
  formatBits |= (matrix.modules[8]?.[8] ? 1 : 0) << 7;
  formatBits |= (matrix.modules[8]?.[7] ? 1 : 0) << 8;
  for (let index = 9; index < 15; index += 1) {
    formatBits |= (matrix.modules[8]?.[14 - index] ? 1 : 0) << index;
  }
  const mask = Array.from({ length: 8 }, (_, candidate) => candidate).find(
    (candidate) => formatBitsForMask(candidate) === formatBits,
  );
  if (mask === undefined) {
    throw new Error("Matrix does not contain valid ECC-M format information");
  }

  const maskBit = (x: number, y: number) => {
    switch (mask) {
      case 0:
        return (x + y) % 2 === 0;
      case 1:
        return y % 2 === 0;
      case 2:
        return x % 3 === 0;
      case 3:
        return (x + y) % 3 === 0;
      case 4:
        return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5:
        return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6:
        return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      case 7:
        return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
      default:
        return false;
    }
  };

  const functions = makeVersionOneFunctionMap(matrix.size);
  const bits: boolean[] = [];
  let upward = true;
  for (let right = matrix.size - 1; right >= 1; right -= 2) {
    if (right === 6) {
      right = 5;
    }
    for (let vertical = 0; vertical < matrix.size; vertical += 1) {
      const y = upward ? matrix.size - 1 - vertical : vertical;
      for (let offset = 0; offset < 2; offset += 1) {
        const x = right - offset;
        if (!functions[y]?.[x]) {
          bits.push(Boolean(matrix.modules[y]?.[x]) !== maskBit(x, y));
        }
      }
    }
    upward = !upward;
  }

  const codewords: number[] = [];
  for (let index = 0; index + 7 < bits.length; index += 8) {
    let value = 0;
    for (let offset = 0; offset < 8; offset += 1) {
      value = (value << 1) | (bits[index + offset] ? 1 : 0);
    }
    codewords.push(value);
  }
  return codewords;
}

describe("encodeQrCode", () => {
  it("lays out finders, separators, and timing patterns correctly", () => {
    const matrix = encodeQrCode("HELLO WORLD", { minEcc: "M" });
    const version = (matrix.size - 17) / 4;

    expect(Number.isInteger(version)).toBe(true);
    expect(matrix.size).toBe(4 * version + 17);
    expectFinder(matrix, 0, 0);
    expectFinder(matrix, matrix.size - 7, 0);
    expectFinder(matrix, 0, matrix.size - 7);

    for (let coordinate = 8; coordinate < matrix.size - 8; coordinate += 1) {
      expect(matrix.modules[6]?.[coordinate]).toBe(coordinate % 2 === 0);
      expect(matrix.modules[coordinate]?.[6]).toBe(coordinate % 2 === 0);
    }
  });

  it("preserves the expected byte-mode data stream for HELLO WORLD", () => {
    const matrix = encodeQrCode("HELLO WORLD", { minEcc: "M" });

    expect(matrix.size).toBe(21);
    expect(readVersionOneDataCodewords(matrix).slice(0, 16)).toEqual([
      0x40, 0xb4, 0x84, 0x54, 0xc4, 0xc4, 0xf2, 0x05, 0x74, 0xf5, 0x24, 0xc4, 0x40, 0xec, 0x11,
      0xec,
    ]);
  });

  it("selects a larger version for a long URL-like payload", () => {
    const shortMatrix = encodeQrCode("0123456789");
    const longPayload = `https://synara.example/pair?token=${"abc123-_".repeat(28)}`;

    expect(longPayload.length).toBeGreaterThan(240);
    expect(() => encodeQrCode(longPayload)).not.toThrow();
    expect(encodeQrCode(longPayload).size).toBeGreaterThan(shortMatrix.size);
  });

  it("is deterministic", () => {
    const first = encodeQrCode("https://synara.example/pair?id=deterministic");
    const second = encodeQrCode("https://synara.example/pair?id=deterministic");

    expect(second).toEqual(first);
  });
});

describe("qrCodeToSvgPath", () => {
  it("emits one valid subpath per dark module", () => {
    const matrix = encodeQrCode("HELLO WORLD");
    const path = qrCodeToSvgPath(matrix);
    const darkModules = matrix.modules.flat().filter(Boolean).length;

    expect(path.length).toBeGreaterThan(0);
    expect(path).toMatch(/^[Mhvz0-9 -]+$/);
    expect(path.match(/M/g)).toHaveLength(darkModules);
  });
});
