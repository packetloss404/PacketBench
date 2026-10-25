import { create } from "zustand";
import { storageKey } from "@/lib/brand";
import { loadFromStorage, saveToStorage } from "@/lib/storage";
import { normalizeCustomCli } from "@/lib/customCli";
import type { CustomCliConfig } from "@/types/workspace";

const key = storageKey("custom-cli-profiles");
const raw = loadFromStorage<unknown>(key, []);
const profiles = (Array.isArray(raw) ? raw : [])
  .map(normalizeCustomCli)
  .filter((p): p is CustomCliConfig => !!p);

export const useCustomCliStore = create<{
  profiles: CustomCliConfig[];
  saveProfile: (profile: CustomCliConfig) => void;
  removeProfile: (name: string) => void;
}>((set) => ({
  profiles,
  saveProfile: (input) => {
    const profile = normalizeCustomCli(input);
    if (!profile)
      throw new Error("Enter a name, executable, valid arguments and environment variables.");
    set((state) => {
      const profiles = [...state.profiles.filter((p) => p.name !== profile.name), profile];
      saveToStorage(key, profiles);
      return { profiles };
    });
  },
  removeProfile: (name) =>
    set((state) => {
      const profiles = state.profiles.filter((p) => p.name !== name);
      saveToStorage(key, profiles);
      return { profiles };
    }),
}));
