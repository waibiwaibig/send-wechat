import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join, extname } from "node:path";

const TTL = 24 * 60 * 60 * 1000;
const CAPACITY = 1024 * 1024 * 1024;
/** Private, bounded storage. Original filenames never determine filesystem paths. */
export class AttachmentStore {
  constructor(private readonly directory: string) {}
  async save(
    fileName: string,
    download: (destination: string) => Promise<void>,
  ): Promise<string> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.directory);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      (process.platform !== "win32" &&
        ((directory.mode & 0o077) !== 0 ||
          directory.uid !== process.getuid?.()))
    )
      throw new Error("ATTACHMENT_DIRECTORY_UNSAFE");
    let size = 0;
    for (const name of await readdir(this.directory)) {
      const path = join(this.directory, name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error("ATTACHMENT_DIRECTORY_UNSAFE");
      if (Date.now() - stat.mtimeMs > TTL) await rm(path);
      else size += stat.size;
    }
    if (size > CAPACITY - 100 * 1024 * 1024)
      throw new Error("ATTACHMENT_STORAGE_FULL");
    const suffix = extname(fileName).toLowerCase();
    const path = join(
      this.directory,
      randomUUID() + (/^\.[a-z0-9]{1,12}$/.test(suffix) ? suffix : ".bin"),
    );
    try {
      await download(path);
      return path;
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
  }
}
