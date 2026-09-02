import { describe, expect, it } from 'vitest';
import {
  SETUP_APP_PREFIX,
  getSetupAppImageUrl,
  deleteSetupAppImage,
} from './ImageStorageService';

describe('ImageStorageService setup_app/ key guard', () => {
  it('builds a public object URL for a setup_app/ key', () => {
    expect(getSetupAppImageUrl(`${SETUP_APP_PREFIX}customer1/site1/level1/bg-1.png`)).toBe(
      'https://com.ensight-technologies.public.s3.us-west-1.amazonaws.com/setup_app/customer1/site1/level1/bg-1.png',
    );
  });

  it('rejects a key outside setup_app/', () => {
    expect(() => getSetupAppImageUrl('other-app/file.png')).toThrow(/setup_app\//);
  });

  it('rejects a root-level key', () => {
    expect(() => getSetupAppImageUrl('file.png')).toThrow(/setup_app\//);
  });

  it('refuses to delete a key outside setup_app/', async () => {
    await expect(deleteSetupAppImage('other-app/file.png')).rejects.toThrow(/setup_app\//);
  });
});
