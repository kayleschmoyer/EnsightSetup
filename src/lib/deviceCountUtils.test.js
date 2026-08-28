import { describe, expect, it } from 'vitest';
import {
  applySignUpdateAcrossSite,
  countSiteDevices,
  reconcileSignInSites,
  removeSignFromSite,
  signLogicalKey,
  uniqueSiteDevices,
} from './deviceCountUtils';

describe('deviceCountUtils', () => {
  const site = {
    levels: [
      {
        id: 1,
        devices: [
          { id: 10, type: 'sign-led', friendlyName: 'B2 Ramp Sign', signLogicalKey: 'b2 ramp sign' },
          { id: 11, type: 'cam-fli', name: 'Cam-1' },
        ],
      },
      {
        id: 2,
        devices: [
          { id: 12, type: 'sign-led', friendlyName: 'B2 Ramp Sign', signLogicalKey: 'b2 ramp sign' },
        ],
      },
      {
        id: 3,
        devices: [
          { id: 13, type: 'sign-led', friendlyName: 'P1 Entry', signLogicalKey: 'p1 entry' },
        ],
      },
    ],
  };

  it('counts logical signs once across levels', () => {
    expect(countSiteDevices(site)).toBe(3);
    expect(uniqueSiteDevices(site)).toHaveLength(3);
  });

  it('dedupes unnamed signs by device id', () => {
    const unnamedSite = {
      levels: [
        { id: 1, devices: [{ id: 1, type: 'sign-led' }, { id: 2, type: 'sign-led' }] },
      ],
    };
    expect(countSiteDevices(unnamedSite)).toBe(2);
    expect(signLogicalKey({ id: 1, type: 'sign-led' })).toBe('__id_1');
  });

  it('propagates sign edits to all level copies', () => {
    const updated = applySignUpdateAcrossSite(
      site,
      10,
      {
        id: 10,
        type: 'sign-led',
        friendlyName: 'B2 Ramp Sign Updated',
        controllerName: 'B2 Ramp Sign Updated',
      },
    );
    const rampSigns = updated.flatMap((l) => l.devices).filter(
      (d) => d.signLogicalKey === 'b2 ramp sign updated',
    );
    expect(rampSigns).toHaveLength(2);
    rampSigns.forEach((copy) => {
      expect(copy.friendlyName).toBe('B2 Ramp Sign Updated');
      expect(copy.signLogicalKey).toBe('b2 ramp sign updated');
    });
    expect(rampSigns[0].id).not.toBe(rampSigns[1].id);
  });

  it('removes all copies of a logical sign', () => {
    const updated = removeSignFromSite(site, 10);
    const signs = updated.flatMap((l) => l.devices).filter((d) => d.type?.startsWith('sign-'));
    expect(signs).toHaveLength(1);
    expect(signs[0].friendlyName).toBe('P1 Entry');
  });

  it('adds sign copies when display levels are assigned', () => {
    const singleLevelSite = {
      id: 1,
      levels: [
        {
          id: 1,
          devices: [{
            id: 10,
            type: 'sign-led',
            friendlyName: 'Entry Sign',
            signLogicalKey: 'entry sign',
            displaySiteId: 1,
            displayLevelIds: [1],
            pendingPlacement: false,
            x: 100,
            y: 200,
          }],
        },
        { id: 2, devices: [] },
      ],
    };

    const updatedSites = reconcileSignInSites([singleLevelSite], 10, {
      id: 10,
      type: 'sign-led',
      friendlyName: 'Entry Sign',
      signLogicalKey: 'entry sign',
      displaySiteId: 1,
      displayLevelAll: false,
      displayLevelIds: [1, 2],
      pendingPlacement: false,
      x: 100,
      y: 200,
    }, { stageSiteId: 1, stageLevelId: 1 });

    const signs = updatedSites[0].levels.flatMap((l) => l.devices).filter((d) => d.type?.startsWith('sign-'));
    expect(signs).toHaveLength(2);
    expect(signs.map((d) => d.id).sort()).toEqual([10, 11]);
  });

  it('applies stage-level placement updates when reconciling sign copies', () => {
    const singleLevelSite = {
      id: 1,
      levels: [{
        id: 1,
        devices: [{
          id: 10,
          type: 'sign-led',
          friendlyName: 'Entry Sign',
          signLogicalKey: 'entry sign',
          displaySiteId: 1,
          displayLevelIds: [1],
          pendingPlacement: true,
          x: 0,
          y: 0,
        }],
      }],
    };

    const updatedSites = reconcileSignInSites([singleLevelSite], 10, {
      id: 10,
      type: 'sign-led',
      friendlyName: 'Entry Sign',
      signLogicalKey: 'entry sign',
      displaySiteId: 1,
      displayLevelIds: [1],
      pendingPlacement: false,
      x: 420,
      y: 310,
    }, { stageSiteId: 1, stageLevelId: 1 });

    const sign = updatedSites[0].levels[0].devices.find((d) => d.id === 10);
    expect(sign.pendingPlacement).toBe(false);
    expect(sign.x).toBe(420);
    expect(sign.y).toBe(310);
  });
});
