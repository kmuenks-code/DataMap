/**
 * Harvard Dataverse file access.
 *
 * Generic on purpose: Dataverse hosts a great deal of the open election and
 * redistricting corpus (VEST's precinct shapefiles live two DOIs away), so the
 * awkward part -- the guestbook -- is solved once here rather than per dataset.
 *
 * THE GUESTBOOK. MEDSL's datasets sit behind a REQUIRED guestbook, so a plain
 * GET on the access endpoint returns HTTP 200 with a JSON error body:
 *
 *     {"status":"ERROR","message":"You may not download this file without the
 *      required Guestbook response for guestbookID 458."}
 *
 * which is rule 7 in a different costume -- `res.ok` is true and only the body
 * gives it away. The documented way through is a POST of the guestbook response
 * to the same endpoint, which returns a short-lived signed URL. See
 * https://guides.dataverse.org/en/latest/api/dataaccess.html ("Basic Download By
 * Dataset").
 *
 * The identity in that response is REQUIRED CONFIG, not an optional nicety. The
 * server will in fact issue a signed URL for an empty response, but the
 * depositor marked name/email/institution/position required, and quietly POSTing
 * blanks forever would be evading a disclosure they asked for in exchange for
 * the data. So the ETL refuses to run without it, exactly as it refuses to run
 * without a Census key -- and it says so in a message that also offers the
 * manual route.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cached } from '../../util/cache.ts';

const SERVER = 'https://dataverse.harvard.edu';

/** Where a hand-downloaded copy may be dropped instead. See requireIdentity(). */
const VENDOR = new URL('../../../vendor/', import.meta.url);

interface GuestbookIdentity {
  name: string;
  email: string;
  institution: string;
  position: string;
}

function requireIdentity(label: string, vendorName: string): GuestbookIdentity {
  const name = process.env.DATAVERSE_NAME ?? '';
  const email = process.env.DATAVERSE_EMAIL ?? '';
  const institution = process.env.DATAVERSE_INSTITUTION ?? '';
  const position = process.env.DATAVERSE_POSITION ?? '';

  if (name && email && institution && position) return { name, email, institution, position };

  throw new Error(
    `[dataverse] cannot download ${label}: this dataset has a REQUIRED guestbook.\n\n` +
      'Two ways forward.\n\n' +
      '  1. Let the ETL answer it. Add to .env (ETL-only, gitignored, and\n' +
      '     deliberately not VITE_-prefixed so it cannot reach the bundle):\n' +
      '         DATAVERSE_NAME=\n' +
      '         DATAVERSE_EMAIL=\n' +
      '         DATAVERSE_INSTITUTION=\n' +
      '         DATAVERSE_POSITION=\n' +
      '     These are sent to Harvard Dataverse with each download, which is what\n' +
      '     the guestbook is for. Nothing is written to .cache/ but the file.\n\n' +
      '  2. Download it yourself once, in a browser, and save it as:\n' +
      `         ${join(fileURLToPath(VENDOR), vendorName)}\n` +
      '     A file found there is used as-is and no request is made at all.\n' +
      '     See docs/data-sources.md.',
  );
}

/**
 * One Dataverse file as text, from the vendor directory or the network.
 *
 * Cached by FILE ID, which is the right granularity: Dataverse mints a new file
 * id for every revision of a file, so a cache hit is always the exact bytes that
 * id names, and a new MEDSL release is a cache miss rather than a stale hit.
 */
export async function fetchDataverseFile(
  fileId: number,
  vendorName: string,
  label: string,
): Promise<string> {
  const vendored = await readFile(new URL(vendorName, VENDOR), 'utf8').catch(() => null);
  if (vendored != null) {
    console.log(`  vendor  ${vendorName} (${(vendored.length / 1e6).toFixed(1)} MB, no request)`);
    return vendored;
  }

  return cached(`dataverse/datafile/${fileId}?format=original`, async () => {
    const identity = requireIdentity(label, vendorName);
    console.log(`  fetch   ${label} (dataverse file ${fileId})`);

    const url = `${SERVER}/api/access/datafile/${fileId}?format=original`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'geodata-columbus/0.1 (open-source civic mapping project)',
      },
      body: JSON.stringify({ guestbookResponse: identity }),
    });
    if (!res.ok) {
      throw new Error(`[dataverse] ${res.status} ${res.statusText} requesting ${label}`);
    }

    // Same trap as the Census API: failures arrive as HTTP 200 with a JSON
    // error body, so the status line proves nothing.
    const envelope = (await res.json()) as {
      status?: string;
      message?: string;
      data?: { signedUrl?: string };
    };
    const signed = envelope.data?.signedUrl;
    if (!signed) {
      throw new Error(
        `[dataverse] no signed URL for ${label}: ${envelope.message ?? JSON.stringify(envelope)}`,
      );
    }

    const file = await fetch(signed, {
      headers: { 'User-Agent': 'geodata-columbus/0.1 (open-source civic mapping project)' },
    });
    if (!file.ok) {
      throw new Error(`[dataverse] ${file.status} on the signed URL for ${label}`);
    }
    const text = await file.text();

    // A signed URL that has expired, or an id that names a restricted file,
    // still answers 200 -- with the JSON error where the CSV should be.
    if (text.trimStart().startsWith('{')) {
      throw new Error(`[dataverse] expected a data file for ${label}, got JSON: ${text.slice(0, 200)}`);
    }
    return text;
  });
}
