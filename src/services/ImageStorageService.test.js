import { describe, expect, it } from 'vitest';
import { getSetupAppImageUrl, deleteSetupAppImage } from './ImageStorageService';

describe('ImageStorageService setup_app/ key guard', () => {
  it('rejects a key outside setup_app/ before ever requesting a presigned URL', async () => {
    await expect(getSetupAppImageUrl('other-app/file.png')).rejects.toThrow(/setup_app\//);
  });

  it('rejects a root-level key', async () => {
    await expect(getSetupAppImageUrl('file.png')).rejects.toThrow(/setup_app\//);
  });

  it('refuses to delete a key outside setup_app/', async () => {
    await expect(deleteSetupAppImage('other-app/file.png')).rejects.toThrow(/setup_app\//);
  });
});
