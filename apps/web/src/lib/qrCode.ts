// FILE: qrCode.ts
// Purpose: Dependency-free QR encoder used to render pairing payloads.
// Layer: Web utility
// Exports: encodeQrCode, qrCodeToSvgPath, QrCodeMatrix

export interface QrCodeMatrix {
  readonly size: number;
  readonly modules: ReadonlyArray<ReadonlyArray<boolean>>; // [y][x], true = dark
}

type EccLevel = "L" | "M" | "Q" | "H";

const ECC_LEVELS: ReadonlyArray<EccLevel> = ["L", "M", "Q", "H"];
const FORMAT_BITS: Readonly<Record<EccLevel, number>> = {
  L: 1,
  M: 0,
  Q: 3,
  H: 2,
};

// Error-correction codewords per block, indexed by ECC level and version.
const ECC_CODEWORDS_PER_BLOCK: ReadonlyArray<ReadonlyArray<number>> = [
  [
    -1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30,
    30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  [
    -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28,
    28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  ],
  [
    -1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30,
    30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  [
    -1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
];

// Number of error-correction blocks, indexed by ECC level and version.
const NUM_ERROR_CORRECTION_BLOCKS: ReadonlyArray<ReadonlyArray<number>> = [
  [
    -1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14,
    15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25,
  ],
  [
    -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23,
    25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
  ],
  [
    -1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34,
    34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68,
  ],
  [
    -1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35,
    37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81,
  ],
];

// Alignment pattern center coordinates, indexed by version.
const ALIGNMENT_PATTERN_POSITIONS: ReadonlyArray<ReadonlyArray<number>> = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
  [6, 28, 50, 72, 94],
  [6, 26, 50, 74, 98],
  [6, 30, 54, 78, 102],
  [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110],
  [6, 30, 58, 86, 114],
  [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122],
  [6, 30, 54, 78, 102, 126],
  [6, 26, 52, 78, 104, 130],
  [6, 30, 56, 82, 108, 134],
  [6, 34, 60, 86, 112, 138],
  [6, 30, 58, 86, 114, 142],
  [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150],
  [6, 24, 50, 76, 102, 128, 154],
  [6, 28, 54, 80, 106, 132, 158],
  [6, 32, 58, 84, 110, 136, 162],
  [6, 26, 54, 82, 110, 138, 166],
  [6, 30, 58, 86, 114, 142, 170],
];

class BitBuffer {
  readonly bits: boolean[] = [];

  append(value: number, length: number): void {
    for (let bit = length - 1; bit >= 0; bit -= 1) {
      this.bits.push(((value >>> bit) & 1) !== 0);
    }
  }
}

function tableValue(table: ReadonlyArray<ReadonlyArray<number>>, ecc: EccLevel, version: number) {
  const row = table[ECC_LEVELS.indexOf(ecc)];
  const value = row?.[version];
  if (value === undefined) {
    throw new Error(`Missing QR table entry for version ${version} at ECC ${ecc}`);
  }
  return value;
}

function getNumRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignmentCount = Math.floor(version / 7) + 2;
    result -= (25 * alignmentCount - 10) * alignmentCount - 55;
  }
  if (version >= 7) {
    result -= 36;
  }
  return result;
}

function getNumDataCodewords(version: number, ecc: EccLevel): number {
  const rawCodewords = Math.floor(getNumRawDataModules(version) / 8);
  return (
    rawCodewords -
    tableValue(ECC_CODEWORDS_PER_BLOCK, ecc, version) *
      tableValue(NUM_ERROR_CORRECTION_BLOCKS, ecc, version)
  );
}

function makeDataCodewords(bytes: Uint8Array, version: number, ecc: EccLevel): number[] {
  const capacity = getNumDataCodewords(version, ecc) * 8;
  const bits = new BitBuffer();
  bits.append(0b0100, 4);
  bits.append(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) {
    bits.append(byte, 8);
  }

  bits.append(0, Math.min(4, capacity - bits.bits.length));
  bits.append(0, (8 - (bits.bits.length % 8)) % 8);

  const result: number[] = [];
  for (let index = 0; index < bits.bits.length; index += 8) {
    let value = 0;
    for (let offset = 0; offset < 8; offset += 1) {
      value = (value << 1) | (bits.bits[index + offset] ? 1 : 0);
    }
    result.push(value);
  }

  for (let padIndex = 0; result.length < capacity / 8; padIndex += 1) {
    result.push(padIndex % 2 === 0 ? 0xec : 0x11);
  }
  return result;
}

function multiplyInGaloisField(left: number, right: number): number {
  let result = 0;
  let multiplicand = left;
  let multiplier = right;
  for (let bit = 0; bit < 8; bit += 1) {
    if ((multiplier & 1) !== 0) {
      result ^= multiplicand;
    }
    const carry = multiplicand & 0x80;
    multiplicand = (multiplicand << 1) & 0xff;
    if (carry !== 0) {
      multiplicand ^= 0x1d;
    }
    multiplier >>>= 1;
  }
  return result;
}

function makeReedSolomonDivisor(degree: number): number[] {
  const result = Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let index = 0; index < degree; index += 1) {
    for (let coefficient = 0; coefficient < result.length; coefficient += 1) {
      const scaled = multiplyInGaloisField(result[coefficient] ?? 0, root);
      result[coefficient] =
        coefficient + 1 < result.length ? scaled ^ (result[coefficient + 1] ?? 0) : scaled;
    }
    root = multiplyInGaloisField(root, 0x02);
  }
  return result;
}

function makeReedSolomonRemainder(data: ReadonlyArray<number>, divisor: ReadonlyArray<number>) {
  const result = Array<number>(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ (result[0] ?? 0);
    result.shift();
    result.push(0);
    for (let index = 0; index < divisor.length; index += 1) {
      result[index] = (result[index] ?? 0) ^ multiplyInGaloisField(divisor[index] ?? 0, factor);
    }
  }
  return result;
}

function addErrorCorrectionAndInterleave(
  data: ReadonlyArray<number>,
  version: number,
  ecc: EccLevel,
): number[] {
  const blockCount = tableValue(NUM_ERROR_CORRECTION_BLOCKS, ecc, version);
  const errorCodewordsPerBlock = tableValue(ECC_CODEWORDS_PER_BLOCK, ecc, version);
  const rawCodewordCount = Math.floor(getNumRawDataModules(version) / 8);
  const shortBlockLength = Math.floor(rawCodewordCount / blockCount);
  const shortBlockCount = blockCount - (rawCodewordCount % blockCount);
  const shortDataLength = shortBlockLength - errorCodewordsPerBlock;
  const divisor = makeReedSolomonDivisor(errorCodewordsPerBlock);
  const dataBlocks: number[][] = [];
  const errorBlocks: number[][] = [];
  let dataIndex = 0;

  for (let block = 0; block < blockCount; block += 1) {
    const dataLength = shortDataLength + (block < shortBlockCount ? 0 : 1);
    const dataBlock = data.slice(dataIndex, dataIndex + dataLength);
    dataIndex += dataLength;
    dataBlocks.push(dataBlock);
    errorBlocks.push(makeReedSolomonRemainder(dataBlock, divisor));
  }

  const result: number[] = [];
  const longestDataLength = shortDataLength + (shortBlockCount < blockCount ? 1 : 0);
  for (let index = 0; index < longestDataLength; index += 1) {
    for (const block of dataBlocks) {
      const value = block[index];
      if (value !== undefined) {
        result.push(value);
      }
    }
  }
  for (let index = 0; index < errorCodewordsPerBlock; index += 1) {
    for (const block of errorBlocks) {
      const value = block[index];
      if (value === undefined) {
        throw new Error("QR error-correction block was shorter than expected");
      }
      result.push(value);
    }
  }
  return result;
}

class MatrixBuilder {
  readonly size: number;
  readonly modules: boolean[][];
  readonly functionModules: boolean[][];

  constructor(
    private readonly version: number,
    private readonly ecc: EccLevel,
    codewords: ReadonlyArray<number>,
  ) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => Array<boolean>(this.size).fill(false));
    this.functionModules = Array.from({ length: this.size }, () =>
      Array<boolean>(this.size).fill(false),
    );
    this.drawFunctionPatterns();
    this.drawCodewords(codewords);
  }

  setFunctionModule(x: number, y: number, dark: boolean): void {
    const moduleRow = this.modules[y];
    const functionRow = this.functionModules[y];
    if (moduleRow === undefined || functionRow === undefined) {
      throw new Error("QR module coordinate is outside the matrix");
    }
    moduleRow[x] = dark;
    functionRow[x] = true;
  }

  drawFunctionPatterns(): void {
    for (let index = 0; index < this.size; index += 1) {
      this.setFunctionModule(6, index, index % 2 === 0);
      this.setFunctionModule(index, 6, index % 2 === 0);
    }

    this.drawFinderPattern(3, 3);
    this.drawFinderPattern(this.size - 4, 3);
    this.drawFinderPattern(3, this.size - 4);

    const positions = ALIGNMENT_PATTERN_POSITIONS[this.version];
    if (positions === undefined) {
      throw new Error(`Missing QR alignment positions for version ${this.version}`);
    }
    const last = positions.length - 1;
    for (let row = 0; row < positions.length; row += 1) {
      for (let column = 0; column < positions.length; column += 1) {
        if ((row === 0 && column === 0) || (row === 0 && column === last)) {
          continue;
        }
        if (row === last && column === 0) {
          continue;
        }
        this.drawAlignmentPattern(positions[column] ?? 0, positions[row] ?? 0);
      }
    }

    this.drawFormatBits(0);
    this.drawVersion();
  }

  drawFinderPattern(centerX: number, centerY: number): void {
    for (let deltaY = -4; deltaY <= 4; deltaY += 1) {
      for (let deltaX = -4; deltaX <= 4; deltaX += 1) {
        const x = centerX + deltaX;
        const y = centerY + deltaY;
        if (x < 0 || y < 0 || x >= this.size || y >= this.size) {
          continue;
        }
        const distance = Math.max(Math.abs(deltaX), Math.abs(deltaY));
        this.setFunctionModule(x, y, distance !== 2 && distance !== 4);
      }
    }
  }

  drawAlignmentPattern(centerX: number, centerY: number): void {
    for (let deltaY = -2; deltaY <= 2; deltaY += 1) {
      for (let deltaX = -2; deltaX <= 2; deltaX += 1) {
        const distance = Math.max(Math.abs(deltaX), Math.abs(deltaY));
        this.setFunctionModule(centerX + deltaX, centerY + deltaY, distance !== 1);
      }
    }
  }

  drawFormatBits(mask: number): void {
    const data = (FORMAT_BITS[this.ecc] << 3) | mask;
    let remainder = data;
    for (let bit = 0; bit < 10; bit += 1) {
      remainder = (remainder << 1) ^ (((remainder >>> 9) & 1) * 0x537);
    }
    const bits = ((data << 10) | remainder) ^ 0x5412;
    const getBit = (index: number) => ((bits >>> index) & 1) !== 0;

    for (let index = 0; index <= 5; index += 1) {
      this.setFunctionModule(8, index, getBit(index));
    }
    this.setFunctionModule(8, 7, getBit(6));
    this.setFunctionModule(8, 8, getBit(7));
    this.setFunctionModule(7, 8, getBit(8));
    for (let index = 9; index < 15; index += 1) {
      this.setFunctionModule(14 - index, 8, getBit(index));
    }

    for (let index = 0; index < 8; index += 1) {
      this.setFunctionModule(this.size - 1 - index, 8, getBit(index));
    }
    for (let index = 8; index < 15; index += 1) {
      this.setFunctionModule(8, this.size - 15 + index, getBit(index));
    }
    this.setFunctionModule(8, this.size - 8, true);
  }

  drawVersion(): void {
    if (this.version < 7) {
      return;
    }
    let remainder = this.version;
    for (let bit = 0; bit < 12; bit += 1) {
      remainder = (remainder << 1) ^ (((remainder >>> 11) & 1) * 0x1f25);
    }
    const bits = (this.version << 12) | remainder;
    for (let index = 0; index < 18; index += 1) {
      const dark = ((bits >>> index) & 1) !== 0;
      const first = this.size - 11 + (index % 3);
      const second = Math.floor(index / 3);
      this.setFunctionModule(first, second, dark);
      this.setFunctionModule(second, first, dark);
    }
  }

  drawCodewords(codewords: ReadonlyArray<number>): void {
    let bitIndex = 0;
    let upward = true;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) {
        right = 5;
      }
      for (let vertical = 0; vertical < this.size; vertical += 1) {
        const y = upward ? this.size - 1 - vertical : vertical;
        for (let offset = 0; offset < 2; offset += 1) {
          const x = right - offset;
          if (this.functionModules[y]?.[x]) {
            continue;
          }
          const byte = codewords[bitIndex >>> 3];
          if (byte !== undefined) {
            const row = this.modules[y];
            if (row === undefined) {
              throw new Error("QR data row is outside the matrix");
            }
            row[x] = ((byte >>> (7 - (bitIndex & 7))) & 1) !== 0;
            bitIndex += 1;
          }
        }
      }
      upward = !upward;
    }
    if (bitIndex !== codewords.length * 8) {
      throw new Error("QR codeword placement did not consume the complete payload");
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        if (!this.functionModules[y]?.[x] && getMaskBit(mask, x, y)) {
          const row = this.modules[y];
          if (row === undefined) {
            throw new Error("QR mask row is outside the matrix");
          }
          row[x] = !row[x];
        }
      }
    }
  }

  selectBestMask(): void {
    let bestMask = 0;
    let bestPenalty = Number.POSITIVE_INFINITY;
    for (let mask = 0; mask < 8; mask += 1) {
      this.applyMask(mask);
      this.drawFormatBits(mask);
      const penalty = getPenaltyScore(this.modules);
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        bestMask = mask;
      }
      this.applyMask(mask);
    }
    this.applyMask(bestMask);
    this.drawFormatBits(bestMask);
  }
}

function getMaskBit(mask: number, x: number, y: number): boolean {
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
      throw new Error(`Invalid QR mask ${mask}`);
  }
}

function scoreRuns(values: ReadonlyArray<boolean>): number {
  let score = 0;
  let runColor = values[0] ?? false;
  let runLength = 1;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] === runColor) {
      runLength += 1;
      if (runLength === 5) {
        score += 3;
      } else if (runLength > 5) {
        score += 1;
      }
    } else {
      runColor = values[index] ?? false;
      runLength = 1;
    }
  }
  return score;
}

function scoreFinderLikePatterns(values: ReadonlyArray<boolean>): number {
  let score = 0;
  for (let start = 0; start + 10 < values.length; start += 1) {
    let bits = 0;
    for (let offset = 0; offset < 11; offset += 1) {
      bits = (bits << 1) | (values[start + offset] ? 1 : 0);
    }
    if (bits === 0x05d || bits === 0x5d0) {
      score += 40;
    }
  }
  return score;
}

function getPenaltyScore(modules: ReadonlyArray<ReadonlyArray<boolean>>): number {
  const size = modules.length;
  let result = 0;

  for (let index = 0; index < size; index += 1) {
    const row = modules[index] ?? [];
    const column = modules.map((moduleRow) => moduleRow[index] ?? false);
    result += scoreRuns(row) + scoreRuns(column);
    result += scoreFinderLikePatterns(row) + scoreFinderLikePatterns(column);
  }

  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const color = modules[y]?.[x];
      if (
        modules[y]?.[x + 1] === color &&
        modules[y + 1]?.[x] === color &&
        modules[y + 1]?.[x + 1] === color
      ) {
        result += 3;
      }
    }
  }

  const darkCount = modules.reduce(
    (total, row) => total + row.reduce((count, dark) => count + (dark ? 1 : 0), 0),
    0,
  );
  const imbalance = Math.abs(darkCount * 20 - size * size * 10);
  result += Math.max(0, Math.ceil(imbalance / (size * size)) - 1) * 10;
  return result;
}

export function encodeQrCode(
  text: string,
  options: { readonly minEcc?: "L" | "M" | "Q" | "H" } = {},
): QrCodeMatrix {
  const ecc = options.minEcc ?? "M";
  if (!ECC_LEVELS.includes(ecc)) {
    throw new Error(`Unsupported QR error-correction level: ${String(ecc)}`);
  }

  const bytes = new TextEncoder().encode(text);
  let version = 1;
  for (; version <= 40; version += 1) {
    const characterCountBits = version <= 9 ? 8 : 16;
    const requiredBits = 4 + characterCountBits + bytes.length * 8;
    if (
      bytes.length < 2 ** characterCountBits &&
      requiredBits <= getNumDataCodewords(version, ecc) * 8
    ) {
      break;
    }
  }
  if (version > 40) {
    throw new Error(
      `QR payload is too long: ${bytes.length} UTF-8 bytes do not fit in version 40 at ECC ${ecc}`,
    );
  }

  const dataCodewords = makeDataCodewords(bytes, version, ecc);
  const allCodewords = addErrorCorrectionAndInterleave(dataCodewords, version, ecc);
  const builder = new MatrixBuilder(version, ecc, allCodewords);
  builder.selectBestMask();
  return {
    size: builder.size,
    modules: builder.modules.map((row) => row.slice()),
  };
}

export function qrCodeToSvgPath(matrix: QrCodeMatrix): string {
  const commands: string[] = [];
  for (let y = 0; y < matrix.size; y += 1) {
    const row = matrix.modules[y];
    for (let x = 0; x < matrix.size; x += 1) {
      if (row?.[x]) {
        commands.push(`M${x} ${y}h1v1h-1z`);
      }
    }
  }
  return commands.join("");
}
