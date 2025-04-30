import tar from "tar";
import * as core from "@actions/core";

export async function listTar(archivePath: string): Promise<void> {
  core.info(`Listing contents of tar archive: ${archivePath}`);
  try {
    await tar.t({
      file: archivePath,
      onentry: entry => core.info(entry.path),
    });
  } catch (err) {
    core.warning(`Failed to list tar contents: ${(err as Error).message}`);
  }
}
