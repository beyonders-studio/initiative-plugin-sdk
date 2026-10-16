/**
 * `initiative-plugin pack`: the plug-in as one listing file, the file a self-hosted
 * deployment publishes as its own plug-in.
 *
 * The listing file is the shape a deployment's listing upload
 * (`POST /api/v1/marketplace/local/upload`, as `{"manifest": <file>}`) and its
 * catalog directory (`MARKETPLACE_EXTRA_CATALOG_DIR`) read: what the catalogue
 * shows, this version's manifest as its `definition`, and its registration.
 * The manifest is the one `build` makes, checked the same way.
 *
 * The listing's picture is named by the path the deployment keeps it under,
 * which is the SHA-256 of its bytes, so it is uploaded beside the file
 * (`POST /api/v1/marketplace/local/media`). A deployment keeps PNG, JPEG, GIF
 * and WebP; any other picture is left out, and the listing shows the
 * deployment's default mark.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { load, registrationOf, type ListedPlugin } from "./build.js";
import type { Manifest } from "./contract.js";

export interface PackOptions {
  /** The plug-in's package directory. */
  root: string;
  /** The module whose default export is the plug-in's definition, relative to `root`. */
  plugin: string;
  /** A plug-in built outside TypeScript, in place of `plugin`: its `BuiltPlugin` file, relative to `root`. */
  manifest?: string;
  /** Where to write the listing file, relative to `root`. Default: `<publicId>-<version>.json`. */
  out?: string;
}

/** Where a deployment serves the pictures uploaded for its listings. */
const MEDIA_PATH = "/api/v1/marketplace/media/";
const KEPT_PICTURES = /\.(png|jpe?g|gif|webp)$/i;

/** The listing file, and the picture to upload beside it (null when it names none). */
export interface Packed {
  listing: Record<string, unknown>;
  avatar: Buffer | null;
}

/** The listing file for a plug-in whose manifest `compile` made. */
export function listingFile(plugin: ListedPlugin, manifest: Manifest, root: string): Packed {
  const listing = plugin.listing;
  if (!listing) throw new Error("pack needs the plug-in's listing: declare `listing` in its definition");
  const avatar = KEPT_PICTURES.test(listing.avatar) ? readFileSync(resolve(root, listing.avatar)) : null;
  const registration = registrationOf(plugin);
  return {
    avatar,
    listing: {
      uid: plugin.uid,
      public_id: plugin.publicId,
      kind: "plugin",
      name: plugin.name,
      publisher: listing.publisher,
      description: listing.summary,
      ...(listing.description !== undefined ? { long_description: listing.description } : {}),
      ...(avatar ? { avatar_url: `${MEDIA_PATH}${createHash("sha256").update(avatar).digest("hex")}` } : {}),
      version: listing.version,
      ...(listing.minAppVersion !== undefined ? { min_app_version: listing.minAppVersion } : {}),
      ...(listing.releaseNotes !== undefined ? { release_notes: listing.releaseNotes } : {}),
      definition: manifest,
      registration,
    },
  };
}

/** Write the plug-in's listing file. Answers the process's exit code. */
export async function pack(options: PackOptions): Promise<number> {
  const root = resolve(options.root);
  const compiled = await load("pack", root, options);
  if (!compiled) return 1;
  if (compiled.problems) {
    for (const problem of compiled.problems) process.stderr.write(`${problem}\n`);
    return 1;
  }
  const { plugin } = compiled;
  let packed: Packed;
  try {
    packed = listingFile(plugin, compiled.manifest, root);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
  const { avatar: picture, version } = plugin.listing!;
  const path = resolve(root, options.out ?? `${plugin.publicId}-${version}.json`);
  writeFileSync(path, `${JSON.stringify(packed.listing, null, 2)}\n`);
  process.stdout.write(
    [
      `wrote ${relative(process.cwd(), path)}: ${plugin.publicId} ${version}, uid ${plugin.uid}`,
      packed.avatar
        ? `upload it with its picture, ${picture}, or run initiative-plugin dev --initiative <url> to do both`
        : `${picture} is not PNG, JPEG, GIF or WebP, so the listing shows the deployment's default mark`,
      "",
    ].join("\n")
  );
  return 0;
}
