import * as tar from "tar";
import * as core from "@actions/core";

/**
 * Extracts a plain .tar archive without compression.
 *
 * @param archivePath - Full path to the .tar file.
 */
export async function extractTar(archivePath: string): Promise<void> {
    try {
        core.info(`Extracting archive: ${archivePath}`);

        await tar.extract({
            file: archivePath,
            cwd: process.env["GITHUB_WORKSPACE"] || process.cwd()
        });

        core.info("Extraction complete.");
    } catch (error) {
        core.error(`Failed to extract tar archive: ${(error as Error).message}`);
        throw error;
    }
}
