import { isDeepStrictEqual } from 'node:util';

import { parse } from 'yaml';

import { redactUnknown } from './config.js';
import type {
  PluginEntry,
  ProfileSnapshot,
  ReconcileReport,
  ExpectedPluginRow,
  UnknownRecord,
} from './types.js';
import type { RenderedProfile } from './patch.js';

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse DSH's composed YAML without evaluating any !!js expression. */
export function parseDshDump(dump: string): readonly PluginEntry[] {
  const value: unknown = parse(dump, {
    logLevel: 'silent',
    customTags: [
      { tag: 'tag:yaml.org,2002:js', resolve: (expression: string) => `!!js ${expression}` },
    ],
  });
  if (!Array.isArray(value)) throw new Error('DSH --dump-config did not return a YAML entry list');
  return value.map((row, index) => {
    if (!isRecord(row)) throw new Error(`DSH --dump-config row ${index} is not an object`);
    return row as PluginEntry;
  });
}

function matchesExpected(actual: unknown, expected: unknown): boolean {
  if (isRecord(expected)) {
    if (!isRecord(actual)) return false;
    return Object.entries(expected).every(([key, value]) => matchesExpected(actual[key], value));
  }
  return isDeepStrictEqual(actual, expected);
}

/** Compare expected rows with the composed tree; extra --patch layers may intentionally override config values. */
export function reconcilePluginState(
  entries: readonly PluginEntry[],
  expectedRows: readonly ExpectedPluginRow[],
  options: { allowConfigOverrides?: boolean } = {},
): ReconcileReport {
  const missingRows: string[] = [];
  const disabledMismatches: string[] = [];
  const configMismatches: string[] = [];
  const warnings: string[] = [];
  const byId = new Map<string, PluginEntry>();
  for (const entry of entries) {
    if (entry.id === undefined) {
      warnings.push('composed tree contains a row without an id');
      continue;
    }
    if (byId.has(entry.id)) warnings.push(`composed tree contains duplicate id ${entry.id}`);
    byId.set(entry.id, entry);
  }
  for (const expected of expectedRows) {
    const actual = byId.get(expected.id);
    if (actual === undefined) {
      missingRows.push(expected.id);
      continue;
    }
    if (expected.disabled !== undefined && (actual.disabled === true) !== expected.disabled) {
      disabledMismatches.push(expected.id);
    }
    if (expected.config !== undefined && !matchesExpected(actual.config, expected.config)) {
      if (options.allowConfigOverrides === true) {
        warnings.push(
          `${expected.id}: config differs from the profile layer; an additional --patch may have overridden it`,
        );
      } else {
        configMismatches.push(expected.id);
      }
    }
  }
  return {
    ok:
      missingRows.length === 0 && disabledMismatches.length === 0 && configMismatches.length === 0,
    missingRows,
    disabledMismatches,
    configMismatches,
    warnings,
  };
}

/** Adapter-owned in-memory assembly state used for diagnostics; it is not session persistence. */
export class AdapterOps {
  private current?: {
    snapshot: ProfileSnapshot;
    expected: readonly ExpectedPluginRow[];
    report: ReconcileReport;
  };

  /** Capture the rendered patch and actual DSH composition after a successful dump. */
  capture(rendered: RenderedProfile, dump: string, allowConfigOverrides: boolean): ProfileSnapshot {
    const snapshot: ProfileSnapshot = {
      capturedAt: new Date().toISOString(),
      profileDir: rendered.profileDir,
      renderedPatch: rendered.renderedPatch,
      entries: parseDshDump(dump),
      dump,
    };
    const report = reconcilePluginState(snapshot.entries, rendered.expected, {
      allowConfigOverrides,
    });
    this.current = { snapshot, expected: rendered.expected, report };
    return snapshot;
  }

  /** Return the latest reconciliation, or fail when prepare has not run. */
  reconcile(): ReconcileReport {
    if (this.current === undefined)
      throw new Error('ops state is unavailable before launcher.prepare()');
    return this.current.report;
  }

  /** Query configured plugin rows, their disabled flags and redacted config. */
  listPlugins(): readonly UnknownRecord[] {
    if (this.current === undefined) return [];
    return this.current.snapshot.entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      state: entry.disabled === true ? 'disabled' : 'configured',
      config: redactUnknown(entry.config),
    }));
  }

  /** Return the latest immutable-by-convention diagnostic snapshot. */
  snapshot(): ProfileSnapshot | undefined {
    return this.current?.snapshot;
  }
}
