import { Controller, Get, Inject, Module } from '@nestjs/common';
import { z } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TEST_CONFIG_ENV, type TestApp } from '../../testing/test-app';
import {
  defineModuleSettings,
  loadConfig,
  MODULE_SETTINGS,
  moduleSettings,
  moduleSettingsDefinitionList,
  policySetting,
  technicalSetting,
  type ModuleSettingsOf,
} from '../config';

export const KernelTestSettings = defineModuleSettings('kerneltest', {
  RENEWAL_LEAD_DAYS: policySetting(z.coerce.number().int().min(1).max(365)),
  SWEEP_BATCH_SIZE: technicalSetting(z.coerce.number().int().min(1).max(500), 25),
});
type KernelTestSettingsValue = ModuleSettingsOf<typeof KernelTestSettings>;

@Controller('module-settings-probe')
class ProbeController {
  constructor(
    @Inject(MODULE_SETTINGS('kerneltest')) private readonly settings: KernelTestSettingsValue,
  ) {}

  @Get()
  read(): KernelTestSettingsValue {
    return this.settings;
  }
}

@Module({ providers: [moduleSettings('kerneltest')], controllers: [ProbeController] })
class ProbeModule {}

describe('module settings in the kernel configuration (K-15, IF-43)', () => {
  it('a malformed module setting refuses boot', () => {
    expect(() => loadConfig({ ...TEST_CONFIG_ENV, KERNELTEST_RENEWAL_LEAD_DAYS: 'soon' })).toThrow(
      /KERNELTEST_RENEWAL_LEAD_DAYS/,
    );
    expect(() => loadConfig({ ...TEST_CONFIG_ENV, KERNELTEST_SWEEP_BATCH_SIZE: '0' })).toThrow(
      /KERNELTEST_SWEEP_BATCH_SIZE/,
    );
  });

  it('an absent optional policy setting reads as undefined, never a default', () => {
    const config = loadConfig({ ...TEST_CONFIG_ENV });
    expect(config.moduleSettings['kerneltest']).toEqual({ SWEEP_BATCH_SIZE: 25 });
    expect('RENEWAL_LEAD_DAYS' in (config.moduleSettings['kerneltest'] ?? {})).toBe(false);
    const set = loadConfig({
      ...TEST_CONFIG_ENV,
      KERNELTEST_RENEWAL_LEAD_DAYS: '14',
      KERNELTEST_SWEEP_BATCH_SIZE: '100',
    });
    expect(set.moduleSettings['kerneltest']).toEqual({
      RENEWAL_LEAD_DAYS: 14,
      SWEEP_BATCH_SIZE: 100,
    });
  });

  it('refuses a second definition of a module and malformed names', () => {
    expect(() => defineModuleSettings('kerneltest', { OTHER: z.string().optional() })).toThrow(
      /already defined/,
    );
    expect(() => defineModuleSettings('Kernel', {})).toThrow(/lower-case/);
    expect(() => defineModuleSettings('kerneltwo', { leadDays: z.string() })).toThrow(/upper-case/);
    expect(moduleSettingsDefinitionList().map((d) => d.module)).toContain('kerneltest');
    expect(MODULE_SETTINGS('kerneltest')).toBe(MODULE_SETTINGS('kerneltest'));
  });

  describe('injected into a module (tests override through createTestApp({ env }))', () => {
    let t: TestApp;
    beforeAll(async () => {
      t = await createTestApp({
        imports: [ProbeModule],
        env: { KERNELTEST_RENEWAL_LEAD_DAYS: '30' },
      });
    });
    afterAll(async () => {
      await t?.close();
    });

    it('the module reads its parsed section', () => {
      expect(t.app.get(MODULE_SETTINGS('kerneltest'))).toEqual({
        RENEWAL_LEAD_DAYS: 30,
        SWEEP_BATCH_SIZE: 25,
      });
    });
  });
});
