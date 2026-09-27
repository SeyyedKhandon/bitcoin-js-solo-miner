import fs from 'fs';

export interface ChangelogEntry {
  version: string;
  date: string;
  changes: string[];
}

/**
 * Parses the most recent "## <version> - <date>" section of CHANGELOG.md
 * (followed by "- " bullet lines) into a structured entry, for showing
 * "what's new" in the dashboard's version badge tooltip.
 */
export function parseLatestChangelogEntry(changelogPath: string): ChangelogEntry | null {
  let text: string;
  try {
    text = fs.readFileSync(changelogPath, 'utf8');
  } catch {
    return null;
  }

  const lines = text.split('\n');
  const headingIndex = lines.findIndex((line) => line.startsWith('## '));
  if (headingIndex === -1) return null;

  const heading = lines[headingIndex].slice(3).trim(); // "1.1.0 - 2026-09-28"
  const [version, ...dateParts] = heading.split(' - ');
  const date = dateParts.join(' - ').trim();

  const changes: string[] = [];
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('## ')) break;
    if (line.startsWith('- ')) changes.push(line.slice(2).trim());
  }

  return { version: version.trim(), date, changes };
}
