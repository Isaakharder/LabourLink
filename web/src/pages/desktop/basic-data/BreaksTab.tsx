import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../../lib/api";
import { BreakProfile } from "../../../lib/breakProfileTypes";
import { BreakProfileListPanel } from "../../../components/breakProfiles/BreakProfileListPanel";
import { BreakProfileEditor } from "../../../components/breakProfiles/BreakProfileEditor";

type StatusFilter = "active" | "inactive" | "all";

export function BreaksTab() {
  const [profiles, setProfiles] = useState<BreakProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");

  const [selectedId, setSelectedId] = useState<string | "new" | null>(null);
  const [resetToken, setResetToken] = useState(0);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    params.set("status", status);

    api<{ breakProfiles: BreakProfile[] }>(`/api/break-profiles?${params.toString()}`)
      .then((res) => {
        setProfiles(res.breakProfiles);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "Could not load break profiles");
      });
  }, [search, status]);

  useEffect(() => {
    const t = window.setTimeout(load, search ? 300 : 0);
    return () => window.clearTimeout(t);
  }, [load, search]);

  return (
    <div className="break-profiles-workspace">
      <BreakProfileListPanel
        profiles={profiles}
        error={error}
        selectedId={selectedId}
        onSelect={(id) => setSelectedId(id)}
        search={search}
        onSearchChange={setSearch}
        status={status}
        onStatusChange={setStatus}
        onAddNew={() => setSelectedId("new")}
      />

      <div className="break-profiles-main">
        {!selectedId ? (
          <p className="placeholder-page break-profile-editor-placeholder">
            Select a break profile, or add a new one.
          </p>
        ) : (
          <BreakProfileEditor
            key={`${selectedId}-${resetToken}`}
            profileId={selectedId}
            onSaved={(profile) => {
              load();
              setSelectedId(profile.id);
            }}
            onCancel={() => {
              if (selectedId === "new") setSelectedId(null);
              else setResetToken((t) => t + 1);
            }}
          />
        )}
      </div>
    </div>
  );
}
