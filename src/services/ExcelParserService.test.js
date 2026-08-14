import { describe, expect, it } from 'vitest';
import { parseDisplayLevelField, serversFromNetworkingRows } from '../services/ExcelParserService';

describe('parseDisplayLevelField', () => {
  it('parses All', () => {
    expect(parseDisplayLevelField('All')).toEqual({ all: true, levelNames: [] });
    expect(parseDisplayLevelField('all')).toEqual({ all: true, levelNames: [] });
  });

  it('parses All Levels variants used in Ensight workbooks', () => {
    expect(parseDisplayLevelField('All Levels')).toEqual({ all: true, levelNames: [] });
    expect(parseDisplayLevelField('all levels')).toEqual({ all: true, levelNames: [] });
    expect(parseDisplayLevelField('All Level')).toEqual({ all: true, levelNames: [] });
    expect(parseDisplayLevelField('ALL_LEVELS')).toEqual({ all: true, levelNames: [] });
  });

  it('parses a single level', () => {
    expect(parseDisplayLevelField('Level B1')).toEqual({
      all: false,
      levelNames: ['Level B1'],
    });
  });

  it('parses comma-separated levels', () => {
    expect(parseDisplayLevelField('Level B1,Level P1,Level P2')).toEqual({
      all: false,
      levelNames: ['Level B1', 'Level P1', 'Level P2'],
    });
  });

  it('returns empty for blank values', () => {
    expect(parseDisplayLevelField('')).toEqual({ all: false, levelNames: [] });
    expect(parseDisplayLevelField(null)).toEqual({ all: false, levelNames: [] });
  });
});

describe('serversFromNetworkingRows', () => {
  it('maps Networking rows to LevelSelector server objects', () => {
    const servers = serversFromNetworkingRows([{
      Manufacturer: '',
      Device: 'EPIC Server',
      Name: 'EPIC-01',
      Status: '',
      Location: '',
      'IDF/MDF Location': '',
      'IP Address  ': '10.0.0.5',
      'IP Assignment Method': 'Static',
      'MAC Address': 'AA:BB',
      Username: 'Administrator',
      Notes: 'Primary',
    }]);
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('EPIC-01');
    expect(servers[0].type).toBe('epic');
    expect(servers[0].ports[0].ip).toBe('10.0.0.5');
    expect(servers[0].ports[0].dhcp).toBe(false);
    expect(servers[0].splashtopUser).toBe('Administrator');
  });

  it('skips rows without a Name', () => {
    expect(serversFromNetworkingRows([{ Device: 'epic', 'IP Address  ': '1.1.1.1' }])).toEqual([]);
  });

  it('maps Device=Server to other so it appears on Servers tab', () => {
    const servers = serversFromNetworkingRows([{
      Device: 'Server',
      Name: 'Main-Host',
      'IP Address  ': '10.0.0.9',
    }]);
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('Main-Host');
    expect(servers[0].type).toBe('other');
  });
});
