import * as core from "@actions/core";
import * as fs from "fs";
import * as path from "path";
import archiver from "archiver";
import { CompressionMethod } from "@actions/cache/lib/internal/constants";

export async function createTar(
  archiveFolder: string,
  sourceDirectories: string[]
): Promise<void> {
  const cacheFileName = "cache.tar";
  const archivePath = path.join(archiveFolder, cacheFileName);

  core.debug(`Creating tarball: ${archivePath}`);

  await tarDirectory(sourceDirectories, archivePath);
}

function getCacheFileName(compressionMethod: CompressionMethod): string {
  return `cache.tar`; // always .tar since we're skipping compression
}

async function tarDirectory(
  sourceDirectories: string[],
  archivePath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(archivePath);
    const archive = archiver("tar"); // 👈 no gzip at all

    output.on("close", () => {
      core.debug(`Tarball size: ${archive.pointer()} bytes`);
      resolve();
    });

    archive.on("warning", (err) => {
      if (err.code === "ENOENT") {
        core.warning(err.message);
      } else {
        reject(err);
      }
    });

    archive.on("error", (err) => reject(err));
    archive.pipe(output);

    for (const directory of sourceDirectories) {
      const base = path.basename(directory);
      archive.directory(directory, base);
    }

    archive.finalize();
  });
}
