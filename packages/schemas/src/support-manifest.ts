import { z } from "zod";

const SEMVER = z.string().regex(/^\d+\.\d+\.\d+$/);

export const SupportCombination = z.object({
  os_distro_release: z.string().min(1),
  arch: z.enum(["x86_64", "aarch64"]),
  kernel_floor: z.string().min(1),
  systemd_version: z.string().min(1),
  runtime_name_version: z.string().min(1),
  workspace_backend: z.enum([
    "btrfs-subvolume",
    "per-agent-mount",
    "per-agent-image",
  ]),
  helper_auth_mode: z.enum(["linux-pam", "windows-secure-desktop"]),
  secret_unlock_mode: z.enum(["os-backed", "passphrase"]),
  required_config: z.array(z.string().min(1)),
});
export type SupportCombination = z.infer<typeof SupportCombination>;

export const SupportManifest = z.object({
  manifest_version: z.number().int().positive(),
  prism_version: SEMVER,
  combinations: z.array(SupportCombination).min(1),
  evidence_bundle: z.string().min(1),
});
export type SupportManifest = z.infer<typeof SupportManifest>;
