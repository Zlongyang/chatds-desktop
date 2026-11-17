export function safeArchiveName(name: string): boolean {
  return (
    !!name &&
    !name.startsWith('/') &&
    !name.includes('\\') &&
    !name.includes('\0') &&
    !name.includes(':') &&
    !name.split('/').some((s) => s === '..' || s === '') &&
    Buffer.byteLength(name) <= 100
  );
}
function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}
export function packTar(files: { name: string; data: Buffer }[]): Buffer {
  const output: Buffer[] = [];
  for (const { name, data } of files) {
    if (!safeArchiveName(name)) throw new Error('归档文件名无效');
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write(octal(0o600, 8), 100);
    header.write(octal(10001, 8), 108);
    header.write(octal(10001, 8), 116);
    header.write(octal(data.length, 12), 124);
    header.write(octal(0, 12), 136);
    header.fill(32, 148, 156);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const sum = header.reduce((n, b) => n + b, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    output.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  output.push(Buffer.alloc(1024));
  return Buffer.concat(output);
}
export function unpackTar(input: Buffer, maxBytes = 65536): { name: string; data: Buffer }[] {
  const result: { name: string; data: Buffer }[] = [];
  let offset = 0,
    total = 0;
  while (offset + 512 <= input.length) {
    const header = input.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').split('\0')[0]!;
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0/g, '').trim();
    if (!/^[0-7]+$/.test(sizeText)) throw new Error('归档长度无效');
    const size = Number.parseInt(sizeText, 8);
    const type = header[156];
    if (
      !safeArchiveName(name) ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      offset + size > input.length ||
      (total += size) > maxBytes
    )
      throw new Error('归档越界或过大');
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]!;
    if (
      checksum !==
      Number.parseInt(header.subarray(148, 156).toString('ascii').replace(/\0/g, '').trim(), 8)
    )
      throw new Error('归档校验失败');
    if (type !== 0 && type !== 48) throw new Error('沙箱导出仅支持普通文件');
    result.push({ name, data: input.subarray(offset, offset + size) });
    offset += Math.ceil(size / 512) * 512;
  }
  return result;
}
