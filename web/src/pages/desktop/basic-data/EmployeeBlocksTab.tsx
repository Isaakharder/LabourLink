import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../../lib/api";
import { EmployeeBlockSummary } from "../../../lib/employeeBlockTypes";
import { employeeBlockColorDef } from "../../../lib/employeeBlockColors";
import { EmployeeBlockFormModal } from "../../../components/employeeBlocks/EmployeeBlockFormModal";
import { useAuth } from "../../../context/AuthContext";

export function EmployeeBlocksTab() {
  const { employee: actor } = useAuth();
  const canCreate = actor?.securityRole === "Administrator";

  const [blocks, setBlocks] = useState<EmployeeBlockSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // null = closed, "new" = create mode, an id = edit mode — same shape
  // CarriersTab's modalCarrier already uses for its own form modal.
  const [modalBlock, setModalBlock] = useState<string | "new" | null>(null);

  const load = useCallback(() => {
    api<{ blocks: EmployeeBlockSummary[] }>("/api/employee-blocks")
      .then((res) => {
        setBlocks(res.blocks);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "Could not load employee blocks");
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section className="setup-section">
      <div className="employees-toolbar">
        <span className="employees-count">
          {blocks ? `${blocks.length} block${blocks.length === 1 ? "" : "s"}` : ""}
        </span>
        {canCreate && (
          <button type="button" className="employees-add-button" onClick={() => setModalBlock("new")}>
            Create Block
          </button>
        )}
      </div>

      {error && <p className="error-text">{error}</p>}

      {!blocks ? (
        <p>Loading...</p>
      ) : blocks.length === 0 ? (
        <p className="placeholder-page">No employee blocks yet.</p>
      ) : (
        <table className="employees-table">
          <thead>
            <tr>
              <th>Colour</th>
              <th>Block name</th>
              <th>Assigned employee</th>
              <th>Linked rows</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {blocks.map((b) => {
              const color = employeeBlockColorDef(b.colorKey);
              return (
              <tr key={b.id}>
                <td>
                  <span
                    className="employee-block-color-preview-swatch"
                    title={color?.label}
                    style={color ? { background: color.fill, borderColor: color.stroke } : undefined}
                  />
                </td>
                <td>{b.name}</td>
                <td>{b.employeeName ?? "Unassigned"}</td>
                <td>{b.rowCount}</td>
                <td>
                  <div className="employee-row-actions">
                    <button type="button" onClick={() => setModalBlock(b.id)}>
                      Edit
                    </button>
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {modalBlock && (
        <EmployeeBlockFormModal
          blockId={modalBlock === "new" ? null : modalBlock}
          onClose={() => setModalBlock(null)}
          onSaved={() => {
            setModalBlock(null);
            load();
          }}
        />
      )}
    </section>
  );
}
