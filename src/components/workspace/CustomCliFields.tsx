import { useState } from "react";
import { useCustomCliStore } from "@/stores/customCliStore";
import { normalizeCustomCli } from "@/lib/customCli";
import type { CustomCliConfig } from "@/types/workspace";

export function CustomCliFields({
  value,
  onChange,
}: {
  value?: CustomCliConfig;
  onChange: (value: CustomCliConfig | undefined) => void;
}) {
  const profiles = useCustomCliStore((s) => s.profiles);
  const saveProfile = useCustomCliStore((s) => s.saveProfile);
  const removeProfile = useCustomCliStore((s) => s.removeProfile);
  const [draft, setDraft] = useState(() => ({
    name: value?.name ?? "",
    command: value?.command ?? "",
    args: JSON.stringify(value?.args ?? []),
    env: JSON.stringify(value?.env ?? {}, null, 2),
    workingDirectory: value?.workingDirectory ?? "",
  }));
  const [error, setError] = useState<string | null>(null);
  function change(next: typeof draft) {
    setDraft(next);
    try {
      const config = normalizeCustomCli({
        ...next,
        args: JSON.parse(next.args),
        env: JSON.parse(next.env),
      });
      onChange(config);
      setError(
        config
          ? null
          : "Enter a profile name and executable; arguments must be a JSON string array and environment a string map.",
      );
    } catch {
      onChange(undefined);
      setError("Arguments and environment must be valid JSON.");
    }
  }
  const inputClass =
    "w-full rounded border border-bg-border bg-bg-primary px-2 py-1 text-ui text-text-primary";
  return (
    <div className="space-y-2 p-2">
      <label className="block text-meta text-text-secondary">
        Saved profile
        <select
          className={inputClass}
          value={profiles.some((p) => p.name === draft.name) ? draft.name : ""}
          onChange={(event) => {
            const profile = profiles.find((p) => p.name === event.target.value);
            change({
              name: profile?.name ?? "",
              command: profile?.command ?? "",
              args: JSON.stringify(profile?.args ?? []),
              env: JSON.stringify(profile?.env ?? {}, null, 2),
              workingDirectory: profile?.workingDirectory ?? "",
            });
          }}
        >
          <option value="">New profile</option>
          {profiles.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-meta text-text-secondary">
        Profile name
        <input
          aria-label="Custom CLI name"
          className={inputClass}
          value={draft.name}
          onChange={(e) => change({ ...draft, name: e.target.value })}
        />
      </label>
      <label className="block text-meta text-text-secondary">
        Executable
        <input
          aria-label="Custom CLI executable"
          placeholder="my-agent or an absolute path"
          className={inputClass}
          value={draft.command}
          onChange={(e) => change({ ...draft, command: e.target.value })}
        />
      </label>
      <label className="block text-meta text-text-secondary">
        Arguments (JSON array)
        <input
          aria-label="Custom CLI arguments"
          placeholder={'["--flag", "value with spaces"]'}
          className={inputClass}
          value={draft.args}
          onChange={(e) => change({ ...draft, args: e.target.value })}
        />
      </label>
      <label className="block text-meta text-text-secondary">
        Environment (JSON object; saved locally)
        <textarea
          aria-label="Custom CLI environment"
          className={inputClass}
          value={draft.env}
          onChange={(e) => change({ ...draft, env: e.target.value })}
        />
      </label>
      <label className="block text-meta text-text-secondary">
        Working directory (absolute path, optional)
        <input
          aria-label="Custom CLI working directory"
          placeholder="Inherit workspace folder"
          className={inputClass}
          value={draft.workingDirectory}
          onChange={(e) => change({ ...draft, workingDirectory: e.target.value })}
        />
      </label>
      <p className="text-meta text-text-muted">
        Use the executable field for one program and Arguments for its options. Paths and
        environment apply on the workspace’s execution host.
      </p>
      {error && (
        <p role="alert" className="text-meta text-accent-red">
          {error}
        </p>
      )}
      <div className="flex gap-2 text-ui">
        <button
          type="button"
          disabled={!value}
          className="text-accent-green disabled:opacity-50"
          onClick={() => {
            if (value) saveProfile(value);
          }}
        >
          Save profile
        </button>
        {profiles.some((p) => p.name === draft.name) && (
          <button
            type="button"
            className="text-text-muted"
            onClick={() => removeProfile(draft.name)}
          >
            Delete saved profile
          </button>
        )}
      </div>
    </div>
  );
}
