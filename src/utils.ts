import { CompressionMethod } from "@actions/cache/lib/internal/constants";
import * as utils from "@actions/cache/lib/internal/cacheUtils";
import * as core from "@actions/core";
import * as minio from "minio";
import { State } from "./state";
import path from "path";
import { createTar } from "./createTar";
import { listTar } from "./listTar";
import * as cache from "@actions/cache";

export function isGhes(): boolean {
  const ghUrl = new URL(
    process.env["GITHUB_SERVER_URL"] || "https://github.com"
  );
  return ghUrl.hostname.toUpperCase() !== "GITHUB.COM";
}

export function getInput(key: string, envKey?: string) {
  let result;
  if (envKey) {
    result = process.env[envKey]
  }
  if (result === undefined) {
    result = core.getInput(key);
  }
  return result;
}

export function newMinio({
  accessKey,
  secretKey,
  sessionToken,
  region,
}: {
  accessKey?: string;
  secretKey?: string;
  sessionToken?: string;
  region?: string;
} = {}) {
  return new minio.Client({
    endPoint: core.getInput("endpoint"),
    port: getInputAsInt("port"),
    useSSL: !getInputAsBoolean("insecure"),
    accessKey: accessKey ?? getInput("accessKey", "AWS_ACCESS_KEY_ID"),
    secretKey: secretKey ?? getInput("secretKey", "AWS_SECRET_ACCESS_KEY"),
    sessionToken: sessionToken ?? getInput("sessionToken", "AWS_SESSION_TOKEN"),
    region: region ?? getInput("region", "AWS_REGION"),
  });
}

export function getInputAsBoolean(
  name: string,
  options?: core.InputOptions
): boolean {
  return core.getInput(name, options) === "true";
}

export function getInputAsArray(
  name: string,
  options?: core.InputOptions
): string[] {
  return core
    .getInput(name, options)
    .split("\n")
    .map((s) => s.trim())
    .filter((x) => x !== "");
}

export function getInputAsInt(
  name: string,
  options?: core.InputOptions
): number | undefined {
  const value = parseInt(core.getInput(name, options));
  if (isNaN(value) || value < 0) {
    return undefined;
  }
  return value;
}

export function formatSize(value?: number, format = "bi") {
  if (!value) return "";
  const [multiple, k, suffix] = (
    format === "bi" ? [1000, "k", "B"] : [1024, "K", "iB"]
  ) as [number, string, string];
  const exp = (Math.log(value) / Math.log(multiple)) | 0;
  const size = Number((value / Math.pow(multiple, exp)).toFixed(2));
  return (
    size +
    (exp ? (k + "MGTPEZY")[exp - 1] + suffix : "byte" + (size !== 1 ? "s" : ""))
  );
}

export function setCacheHitOutput(isCacheHit: boolean): void {
  core.setOutput("cache-hit", isCacheHit.toString());
}

export function setCacheSizeOutput(cacheSize: number): void {
  core.setOutput("cache-size", cacheSize.toString())
}

type FindObjectResult = {
  item: minio.BucketItem;
  matchingKey: string;
};

export async function findObject(
    mc: minio.Client,
    bucket: string,
    key: string,
    restoreKeys: string[]
): Promise<{ item: { name: string; size: number }; matchingKey: string }> {
  const keys = [key, ...restoreKeys];
  const suffix = ".tar";

  for (const currentKey of keys) {
    const objectName = `${currentKey}${suffix}`;
    try {
      const stat = await mc.statObject(bucket, objectName);
      core.info(`Found object ${objectName} in bucket ${bucket}`);
      return {
        item: { name: objectName, size: stat.size },
        matchingKey: currentKey,
      };
    } catch (err: any) {
      if (err.code !== "NotFound") {
        core.warning(`Error checking object ${objectName}: ${err.message}`);
      } else {
        core.info(`Object ${objectName} not found in bucket ${bucket}`);
      }
    }
  }

  throw new Error(`No cache entry found for keys: ${keys.join(", ")}`);
}

export function listObjects(
  mc: minio.Client,
  bucket: string,
  prefix: string
): Promise<minio.BucketItem[]> {
  return new Promise((resolve, reject) => {
    const h = mc.listObjectsV2(bucket, prefix, true);
    const r: minio.BucketItem[] = [];
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved)
        reject(new Error("list objects no result after 10 seconds"));
    }, 10000);

    h.on("data", (obj) => {
      r.push(obj);
    });
    h.on("error", (e) => {
      resolved = true;
      reject(e);
      clearTimeout(timeout)
    });
    h.on("end", () => {
      resolved = true;
      resolve(r);
      clearTimeout(timeout)
    });
  });
}

export function saveMatchedKey(matchedKey: string) {
  return core.saveState(State.MatchedKey, matchedKey);
}

function getMatchedKey() {
  return core.getState(State.MatchedKey);
}

export function isExactKeyMatch(): boolean {
  const matchedKey = getMatchedKey();
  const inputKey = core.getState(State.PrimaryKey);
  const result = getMatchedKey() === inputKey;
  core.debug(
    `isExactKeyMatch: matchedKey=${matchedKey} inputKey=${inputKey}, result=${result}`
  );
  return result;
}

export async function saveCache(standalone: boolean) {
  try {
    if (!standalone && isExactKeyMatch()) {
      core.info("Cache was exact key match, not saving");
      return;
    }

    const bucket = core.getInput("bucket", { required: true });
    // Inputs are re-evaluted before the post action, so we want the original key
    const key = standalone ? core.getInput("key", { required: true }) : core.getState(State.PrimaryKey);
    const useFallback = getInputAsBoolean("use-fallback");
    const paths = getInputAsArray("path");

    try {
      const mc = newMinio({
        // Inputs are re-evaluted before the post action, so we want the original keys & tokens
        accessKey: standalone ? getInput("accessKey", "AWS_ACCESS_KEY_ID") : core.getState(State.AccessKey),
        secretKey: standalone ? getInput("secretKey", "AWS_SECRET_ACCESS_KEY") : core.getState(State.SecretKey),
        sessionToken: standalone ? getInput("sessionToken", "AWS_SESSION_TOKEN") : core.getState(State.SessionToken),
        region: standalone ? getInput("region", "AWS_REGION") : core.getState(State.Region),
      });

      const cachePaths = await utils.resolvePaths(paths);
      core.debug("Cache Paths:");
      core.debug(`${JSON.stringify(cachePaths)}`);

      const archiveFolder = await utils.createTempDirectory();
      const cacheFileName = "cache.tar";
      const archivePath = path.join(archiveFolder, cacheFileName);

      core.info(`Archive Path: ${archivePath}`);

      await createTar(archiveFolder, cachePaths);
      if (core.isDebug()) {
        await listTar(archivePath);
      }

      const object = path.join(key, cacheFileName);

      const now = () => new Date().toISOString();
      core.info(`[${now()}] Uploading tar to s3. Bucket: ${bucket}, Object: ${object}`);
      await mc.fPutObject(bucket, object, archivePath, {});
      core.info(`[${now()}] Cache saved to bucket successfully (took ${(new Date().getTime() - new Date(now()).getTime())/1000}s)`);
    } catch (e) {
      if (useFallback) {
        if (isGhes()) {
          core.warning("Cache fallback is not supported on Github Enterpise.");
        } else {
          core.info("Saving cache using fallback");
          await cache.saveCache(paths, key);
          core.info("Save cache using fallback successfully");
        }
      } else {
        core.debug("skipped fallback cache");
        core.warning("Save s3 cache failed: " + e.message);
      }
    }
  } catch (e) {
    core.info("warning: " + e.message);
  }
}
