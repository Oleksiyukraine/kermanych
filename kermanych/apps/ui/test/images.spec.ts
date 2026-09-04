import { describe, expect, it } from 'vitest';
import { imageToFile, type AttachedImage } from '../src/lib/images';

// imageToFile feeds the board's create path: `board.createTask` uploads File[] to the
// task-images bucket, but the composer only ever held the base64 an AttachedImage carries.
// The round-trip has to hand storage back the exact bytes, name and content type, or the
// object it writes is not the image the operator pasted.
describe('imageToFile', () => {
  // "hi" as base64 — a payload whose bytes we can assert exactly.
  const img: AttachedImage = { data: 'aGk=', mimeType: 'image/png', url: 'data:...', name: 'pasted.png' };

  it('rebuilds a File with the name and mime the attachment carried', () => {
    const file = imageToFile(img);
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe('pasted.png');
    expect(file.type).toBe('image/png');
  });

  it('decodes the base64 payload back to its original bytes', async () => {
    const file = imageToFile(img);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([0x68, 0x69]));
  });
});
