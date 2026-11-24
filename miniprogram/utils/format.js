/** 编码与格式化工具：NFC 需要 UTF-8 / ArrayBuffer 互转。 */

function utf8Encode(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        const codePoint = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        out.push(0xf0 | (codePoint >> 18), 0x80 | ((codePoint >> 12) & 0x3f),
          0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
        i++;
        continue;
      }
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return new Uint8Array(out);
}

function utf8Decode(bytes) {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i += 1;
    } else if (b < 0xe0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if (b < 0xf0) {
      out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f));
      i += 3;
    } else {
      const cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12)
        | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
      const offset = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
      i += 4;
    }
  }
  return out;
}

function toBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function hexToBuffer(hex) {
  const clean = String(hex || '').replace(/\s+/g, '');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return toBuffer(bytes);
}

function bufferToHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function cleanTitle(raw) {
  let title = String(raw || '').replace(/[\u200e\u200f]/g, '').trim();
  title = title.replace(/\s*\(\d{4}\)\s*$/, '').trim();
  for (let i = 1; i < title.length; i++) {
    const code = title.charCodeAt(i);
    if (title[i - 1] === ' ' && code < 128 && /[A-Za-z]/.test(title[i])) {
      return title.slice(0, i).trim();
    }
  }
  return title;
}

function rarityFor(rating) {
  const value = Number(rating) || 0;
  if (value >= 9.4) return 'LR';
  if (value >= 9.1) return 'UR';
  if (value >= 8.7) return 'SSR';
  if (value >= 8.3) return 'SR';
  if (value >= 7.9) return 'R';
  return 'C';
}

module.exports = {
  utf8Encode,
  utf8Decode,
  toBuffer,
  hexToBuffer,
  bufferToHex,
  cleanTitle,
  rarityFor,
};
