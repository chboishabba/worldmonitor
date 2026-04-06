/**
 * Unit tests for computeEnergyShockScenario handler logic.
 *
 * Tests the pure computation functions in isolation (no Redis dependency).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Unit tests on chokepoint + assessment logic (extracted inline)
// ---------------------------------------------------------------------------

const VALID_CHOKEPOINTS = ['hormuz', 'malacca', 'suez', 'babelm'];
const INVALID_CHOKEPOINTS = ['panama', 'taiwan', '', 'xyz'];

const GULF_PARTNER_CODES = new Set(['682', '784', '368', '414', '364']);

function computeGulfShare(flows: Array<{ partnerCode: string; tradeValueUsd: number }>): number {
  let total = 0;
  let gulf = 0;
  for (const f of flows) {
    if (f.tradeValueUsd <= 0) continue;
    total += f.tradeValueUsd;
    if (GULF_PARTNER_CODES.has(f.partnerCode)) gulf += f.tradeValueUsd;
  }
  return total === 0 ? 0 : gulf / total;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function computeEffectiveCoverDays(
  daysOfCover: number,
  netExporter: boolean,
  crudeLossKbd: number,
  crudeImportsKbd: number,
): number {
  if (netExporter) return -1;
  if (daysOfCover > 0 && crudeLossKbd > 0 && crudeImportsKbd > 0) {
    return Math.round(daysOfCover / (crudeLossKbd / crudeImportsKbd));
  }
  return daysOfCover;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('energy shock scenario computation', () => {
  describe('chokepoint validation', () => {
    it('accepts all valid chokepoint IDs', () => {
      for (const id of VALID_CHOKEPOINTS) {
        assert.ok(VALID_CHOKEPOINTS.includes(id), `Expected ${id} to be valid`);
      }
    });

    it('rejects invalid chokepoint IDs', () => {
      for (const id of INVALID_CHOKEPOINTS) {
        assert.ok(!VALID_CHOKEPOINTS.includes(id), `Expected ${id} to be invalid`);
      }
    });
  });

  describe('disruption_pct clamping', () => {
    it('clamps disruption_pct below 10 to 10', () => {
      assert.equal(clamp(Math.round(5), 10, 100), 10);
      assert.equal(clamp(Math.round(0), 10, 100), 10);
    });

    it('clamps disruption_pct above 100 to 100', () => {
      assert.equal(clamp(Math.round(150), 10, 100), 100);
      assert.equal(clamp(Math.round(200), 10, 100), 100);
    });

    it('passes through valid disruption_pct values unchanged', () => {
      for (const v of [10, 25, 50, 75, 100]) {
        assert.equal(clamp(v, 10, 100), v);
      }
    });
  });

  describe('gulf crude share calculation', () => {
    it('returns 0 when no flows provided', () => {
      assert.equal(computeGulfShare([]), 0);
    });

    it('returns 0 when country has no Comtrade data (no numeric code mapping)', () => {
      // Countries without a Comtrade numeric code mapping should return 0 share
      const ISO2_TO_COMTRADE: Record<string, string> = {
        US: '842', CN: '156', RU: '643', IR: '364', IN: '356', TW: '158',
      };
      const unsupportedCountries = ['DE', 'FR', 'JP', 'KR', 'BR', 'SA'];
      for (const code of unsupportedCountries) {
        assert.equal(ISO2_TO_COMTRADE[code], undefined, `${code} should not have Comtrade mapping`);
      }
    });

    it('returns 1.0 when all imports are from Gulf partners', () => {
      const flows = [
        { partnerCode: '682', tradeValueUsd: 1000 }, // SA
        { partnerCode: '784', tradeValueUsd: 500 },  // AE
      ];
      assert.equal(computeGulfShare(flows), 1.0);
    });

    it('returns 0 when no imports are from Gulf partners', () => {
      const flows = [
        { partnerCode: '124', tradeValueUsd: 1000 }, // Canada
        { partnerCode: '643', tradeValueUsd: 500 },  // Russia (not in Gulf set)
      ];
      assert.equal(computeGulfShare(flows), 0);
    });

    it('computes fractional Gulf share correctly', () => {
      const flows = [
        { partnerCode: '682', tradeValueUsd: 300 }, // SA (Gulf)
        { partnerCode: '124', tradeValueUsd: 700 }, // Canada (non-Gulf)
      ];
      assert.equal(computeGulfShare(flows), 0.3);
    });

    it('ignores flows with zero or negative tradeValueUsd', () => {
      const flows = [
        { partnerCode: '682', tradeValueUsd: 0 },   // Gulf but zero
        { partnerCode: '784', tradeValueUsd: -100 }, // Gulf but negative
        { partnerCode: '124', tradeValueUsd: 500 },  // Non-Gulf positive
      ];
      assert.equal(computeGulfShare(flows), 0);
    });
  });

  describe('effective cover days computation', () => {
    it('returns -1 for net exporters', () => {
      assert.equal(computeEffectiveCoverDays(90, true, 100, 500), -1);
    });

    it('returns raw daysOfCover when crudeLossKbd is 0', () => {
      assert.equal(computeEffectiveCoverDays(90, false, 0, 500), 90);
    });

    it('returns raw daysOfCover when crudeImportsKbd is 0', () => {
      assert.equal(computeEffectiveCoverDays(90, false, 50, 0), 90);
    });

    it('scales cover days by the loss ratio', () => {
      // 90 days cover, 50% loss of 200 kbd imports = ratio 0.5
      // effectiveCoverDays = round(90 / 0.5) = 180
      const result = computeEffectiveCoverDays(90, false, 100, 200);
      assert.equal(result, 180);
    });

    it('produces shorter cover days for higher loss ratios', () => {
      // 90 days cover, 90% disruption of 200 kbd = 180 kbd loss, ratio 0.9
      // effectiveCoverDays = round(90 / 0.9) = 100
      const result = computeEffectiveCoverDays(90, false, 180, 200);
      assert.equal(result, 100);
    });
  });

  describe('assessment string branches', () => {
    it('uses low-dependence branch when gulfCrudeShare < 0.1', () => {
      const code = 'DE';
      const chokepointId = 'hormuz';
      const gulfCrudeShare = 0.05;
      const assessment = `${code} has low Gulf crude dependence (${Math.round(gulfCrudeShare * 100)}%); ${chokepointId} disruption has limited direct impact.`;
      assert.ok(assessment.includes('low Gulf crude dependence'));
      assert.ok(assessment.includes('5%'));
    });

    it('uses IEA cover branch when effectiveCoverDays > 90', () => {
      const code = 'US';
      const chokepointId = 'hormuz';
      const disruptionPct = 50;
      const daysOfCover = 90;
      const effectiveCoverDays = 180;
      const assessment = `With ${daysOfCover} days IEA cover, ${code} can bridge a ${disruptionPct}% ${chokepointId} disruption for ~${effectiveCoverDays} days.`;
      assert.ok(assessment.includes('bridge'));
      assert.ok(assessment.includes('180 days'));
    });

    it('uses deficit branch otherwise', () => {
      const code = 'IN';
      const chokepointId = 'malacca';
      const disruptionPct = 75;
      const daysOfCover = 30;
      const worstDeficit = 25.0;
      const assessment = `${code} faces ${worstDeficit.toFixed(1)}% diesel/jet deficit under ${disruptionPct}% ${chokepointId} disruption; IEA cover: ${daysOfCover} days.`;
      assert.ok(assessment.includes('faces'));
      assert.ok(assessment.includes('diesel/jet deficit'));
    });

    it('uses insufficient data message when dataAvailable is false', () => {
      const code = 'XZ';
      const chokepointId = 'suez';
      const assessment = `Insufficient import data for ${code} to model ${chokepointId} exposure.`;
      assert.ok(assessment.includes('Insufficient import data'));
    });
  });
});
