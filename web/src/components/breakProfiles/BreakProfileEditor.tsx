import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../../lib/api";
import { uuid } from "../../lib/uuid";
import { BreakProfile, BreakProfileItem, BreakProfileItemDraft } from "../../lib/breakProfileTypes";
import { BreakProfileItemRow } from "./BreakProfileItemRow";

interface BreakProfileEditorProps {
  // A real id loads and edits that profile; "new" starts a blank draft.
  profileId: string | "new";
  onSaved: (profile: BreakProfile, wasNew: boolean) => void;
  onCancel: () => void;
}

function toDraftItem(item: BreakProfileItem): BreakProfileItemDraft {
  return {
    id: item.id,
    name: item.name ?? "",
    startTime: item.startTime.slice(0, 5),
    endTime: item.endTime.slice(0, 5),
    isPaid: item.isPaid,
    fixedBreak: item.fixedBreak,
    autoAdd: item.autoAdd,
    fixedStartWindowMinutes: item.fixedStartWindowMinutes,
    fixedEndWindowMinutes: item.fixedEndWindowMinutes,
  };
}

function blankItem(): BreakProfileItemDraft {
  return {
    id: uuid(),
    name: "",
    startTime: "",
    endTime: "",
    isPaid: false,
    fixedBreak: false,
    autoAdd: false,
    fixedStartWindowMinutes: 10,
    fixedEndWindowMinutes: 10,
  };
}

export function BreakProfileEditor({ profileId, onSaved, onCancel }: BreakProfileEditorProps) {
  const [loading, setLoading] = useState(profileId !== "new");
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [items, setItems] = useState<BreakProfileItemDraft[]>([]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    setSaveError(null);
    setFieldErrors({});

    if (profileId === "new") {
      setName("");
      setDescription("");
      setIsActive(true);
      setItems([]);
      setLoading(false);
      setLoadError(null);
      return;
    }

    setLoading(true);
    setLoadError(null);
    api<{ breakProfile: BreakProfile }>(`/api/break-profiles/${profileId}`)
      .then((res) => {
        const p = res.breakProfile;
        setName(p.name);
        setDescription(p.description ?? "");
        setIsActive(p.isActive);
        setItems(p.items.map(toDraftItem));
      })
      .catch((err) => {
        setLoadError(err instanceof ApiError ? err.message : "Could not load break profile");
      })
      .finally(() => setLoading(false));
  }, [profileId]);

  const overlapWarning = useMemo(() => {
    const sorted = [...items]
      .filter((it) => it.startTime && it.endTime)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].startTime < sorted[i - 1].endTime) {
        return "Two or more scheduled breaks overlap — double-check the times.";
      }
    }
    return null;
  }, [items]);

  function patchItem(id: string, patch: Partial<BreakProfileItemDraft>) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }

  function moveItem(id: string, direction: -1 | 1) {
    setItems((prev) => {
      const index = prev.findIndex((it) => it.id === id);
      const swapWith = index + direction;
      if (index === -1 || swapWith < 0 || swapWith >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[swapWith]] = [next[swapWith], next[index]];
      return next;
    });
  }

  function validateClientSide(): string | null {
    if (!name.trim()) return "Profile name is required.";
    if (items.length === 0) return "At least one scheduled break is required.";
    const seen = new Set<string>();
    for (const it of items) {
      if (!it.startTime || !it.endTime) return "Each scheduled break needs a start and end time.";
      if (it.endTime <= it.startTime) return "End time must be after start time for every scheduled break.";
      const key = `${it.startTime}-${it.endTime}`;
      if (seen.has(key)) return "Two scheduled breaks have the exact same start and end time.";
      seen.add(key);
    }
    return null;
  }

  async function handleSave() {
    const clientError = validateClientSide();
    if (clientError) {
      setSaveError(clientError);
      return;
    }

    setSaving(true);
    setSaveError(null);
    setFieldErrors({});

    const payload = {
      name: name.trim(),
      description: description.trim() || null,
      isActive,
      // Sending each row's id lets the server tell an existing row (update
      // in place, preserving history already recorded against it) from a
      // brand-new one (insert) — see upsertItems in breakProfiles.ts. Every
      // draft item already has a real uuid by this point, either the
      // server's own (loaded rows, via toDraftItem) or one generated
      // client-side when the row was added (blankItem) — either way it's
      // safe to send as-is.
      items: items.map((it) => ({
        id: it.id,
        name: it.name.trim() || null,
        startTime: it.startTime,
        endTime: it.endTime,
        isPaid: it.isPaid,
        fixedBreak: it.fixedBreak,
        autoAdd: it.autoAdd,
        fixedStartWindowMinutes: it.fixedStartWindowMinutes,
        fixedEndWindowMinutes: it.fixedEndWindowMinutes,
      })),
    };

    try {
      const res =
        profileId === "new"
          ? await api<{ breakProfile: BreakProfile }>("/api/break-profiles", {
              method: "POST",
              body: JSON.stringify(payload),
            })
          : await api<{ breakProfile: BreakProfile }>(`/api/break-profiles/${profileId}`, {
              method: "PATCH",
              body: JSON.stringify(payload),
            });
      onSaved(res.breakProfile, profileId === "new");
    } catch (err) {
      if (err instanceof ApiError) {
        setSaveError(err.message);
        if (err.errors) setFieldErrors(err.errors);
      } else {
        setSaveError("Could not save break profile");
      }
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="break-profile-editor-placeholder">Loading...</p>;
  if (loadError) return <p className="error-text break-profile-editor-placeholder">{loadError}</p>;

  return (
    <div className="break-profile-editor">
      <section className="employee-form-section">
        <h3>Profile</h3>
        <div className="employee-form-grid">
          <label>
            Profile name *
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
            {fieldErrors.name && <span className="field-error">{fieldErrors.name}</span>}
          </label>
          <label>
            Description
            <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label className="employee-form-checkbox">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Active
          </label>
        </div>
      </section>

      <section className="break-profile-items-section">
        <div className="break-profile-items-header">
          <h3>Scheduled breaks</h3>
          <button type="button" onClick={() => setItems((prev) => [...prev, blankItem()])}>
            Add Break
          </button>
        </div>

        {overlapWarning && <p className="break-profile-warning">{overlapWarning}</p>}
        {fieldErrors.items && <p className="field-error">{fieldErrors.items}</p>}

        {items.length === 0 ? (
          <p className="placeholder-page">
            No scheduled breaks yet — add at least one before saving.
          </p>
        ) : (
          <div className="break-item-row-list">
            {items.map((item, index) => (
              <BreakProfileItemRow
                key={item.id}
                item={item}
                isFirst={index === 0}
                isLast={index === items.length - 1}
                onChange={(patch) => patchItem(item.id, patch)}
                onRemove={() => removeItem(item.id)}
                onMoveUp={() => moveItem(item.id, -1)}
                onMoveDown={() => moveItem(item.id, 1)}
              />
            ))}
          </div>
        )}
      </section>

      {saveError && <p className="error-text">{saveError}</p>}

      <div className="break-profile-editor-actions">
        <button type="button" className="employees-add-button" onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </button>
        <button type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </div>
  );
}
