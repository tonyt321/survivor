import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const empty = () => ({ characters: [], game: null });

// Saves the whole app state to one JSON file. Pass null as the file to keep it in memory only.
export function createStore(file) {
  return {
    async load() {
      if (!file) return empty();
      try {
        return { ...empty(), ...JSON.parse(await readFile(file, 'utf8')) };
      } catch (err) {
        if (err.code === 'ENOENT') return empty();
        throw err;
      }
    },
    async save(state) {
      if (!file) return;
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(state, null, 2));
      await rename(tmp, file);
    },
  };
}
