// Files the director attaches to a task (create, edit, or a steer) are stored
// under HIVE_HOME/evidence/<task-id>/ and their ABSOLUTE paths appended to the
// brief under "## Attachments" — agents read them off disk, so a path is what
// the agent needs. A human needs the picture. This lifts that block back out of
// the brief and turns each path into the URL the server serves it at.
//
// Deliberately NOT evidence rows: `evidence` gates the done transition, and an
// input the director attached is not proof of work (server/src/api.ts
// attachFiles says the same). Parsing the block keeps that gate untouched.

export interface Attachment {
  path: string;
  name: string;
  url: string;
  image: boolean;
}

// The heading, any number of non-bullet prose lines, then the "- <path>" list.
const BLOCK = /\n*## Attachments\n(?:(?![ \t]*- )[^\n]*\n)*((?:[ \t]*- [^\n]+\n?)+)/g;
const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

// /evidence/<task-id>/<file> — the last two segments of the stored path, which
// is exactly what serveEvidence() resolves back against HIVE_HOME.
export function attachmentUrl(path: string): string {
  const [dir, name] = path.split("/").slice(-2);
  return `/evidence/${encodeURIComponent(dir)}/${encodeURIComponent(name)}`;
}

export function splitAttachments(brief: string | null | undefined): { body: string; files: Attachment[] } {
  const files: Attachment[] = [];
  const body = (brief ?? "")
    .replace(BLOCK, (_m, list: string) => {
      for (const line of list.trim().split("\n")) {
        const path = line.trim().slice(2).trim();
        // Stored as "<epoch-ms>[_<n>]_<original name>". The stamp is storage
        // plumbing (uniqueness); show the name the director recognises.
        const name = (path.split("/").pop() || path).replace(/^\d{10,}_(\d+_)?/, "");
        files.push({ path, name, url: attachmentUrl(path), image: IMAGE.test(name) });
      }
      return "\n";
    })
    .trim();
  return { body, files };
}
