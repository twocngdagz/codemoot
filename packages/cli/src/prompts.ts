import { createInterface } from 'node:readline/promises';
import { listPresets } from '@codemoot/core';
import type { PresetName } from '@codemoot/core';

export async function selectPreset(): Promise<PresetName> {
  const presets = listPresets();
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  try {
    console.error('Available presets:');
    presets.forEach((preset, index) => {
      console.error(`  ${index + 1}. ${preset}`);
    });
    const answer = (await readline.question(`Select a preset [1-${presets.length}] (1): `)).trim();
    const index = answer === '' ? 0 : Number.parseInt(answer, 10) - 1;
    const selected = presets[index];
    return selected ?? presets[0] ?? 'cli-first';
  } finally {
    readline.close();
  }
}
