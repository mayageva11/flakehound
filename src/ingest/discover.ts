import { glob } from 'tinyglobby';

export async function discoverXmlFiles(
  patterns: string | string[],
  cwd: string = process.cwd(),
): Promise<string[]> {
  const files = await glob(patterns, { cwd, absolute: true });
  return [...files].sort();
}
