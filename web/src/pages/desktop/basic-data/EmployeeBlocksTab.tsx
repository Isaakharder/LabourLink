import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../../lib/api";
import { EmployeeBlockSummary } from "../../../lib/employeeBlockTypes";
import { EmployeeBlockFormModal } from "../../../components/employeeBlocks/EmployeeBlockFormModal";

export function EmployeeBlocksTab() {
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
        <button type="button" className="employees-add-button" onClick={() => setModalBlock("new")}>
          Create Block
        </button>
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
              <th>Block name</th>
              <th>Assigned employee</th>
              <th>Linked rows</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {blocks.map((b) => (
              <tr key={b.id}>
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
            ))}
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
