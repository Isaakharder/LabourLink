import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../../lib/api";
import { PlantDensitySummary, PlantDensityType } from "../../../lib/plantDensityTypes";
import { PlantDensityFormModal } from "../../../components/plantDensity/PlantDensityFormModal";

const COUNT_PER_ROW_HEADER: Record<PlantDensityType, string> = {
  plants: "Plants per row",
  stems: "Stems per row",
};

interface DensityCardProps {
  type: PlantDensityType;
  title: string;
}

function DensityCard({ type, title }: DensityCardProps) {
  const [densities, setDensities] = useState<PlantDensitySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // null = closed, "new" = create mode, an id = edit mode — same shape
  // EmployeeBlocksTab's modalBlock already uses.
  const [modalDensity, setModalDensity] = useState<string | "new" | null>(null);

  const load = useCallback(() => {
    api<{ densities: PlantDensitySummary[] }>(`/api/plant-densities?type=${type}`)
      .then((res) => {
        setDensities(res.densities);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "Could not load plant densities");
      });
  }, [type]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="density-card">
      <h3>{title}</h3>

      <div className="employees-toolbar">
        <span className="employees-count">
          {densities ? `${densities.length} densit${densities.length === 1 ? "y" : "ies"}` : ""}
        </span>
        <button type="button" className="employees-add-button" onClick={() => setModalDensity("new")}>
          Create Density
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {!densities ? (
        <p>Loading...</p>
      ) : densities.length === 0 ? (
        <p className="placeholder-page">No {title.toLowerCase()} densities yet.</p>
      ) : (
        <table className="employees-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>{COUNT_PER_ROW_HEADER[type]}</th>
              <th>Linked rows</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {densities.map((d) => (
              <tr key={d.id}>
                <td>{d.name}</td>
                <td>{d.countPerRow}</td>
                <td>{d.rowCount}</td>
                <td>
                  <div className="employee-row-actions">
                    <button type="button" onClick={() => setModalDensity(d.id)}>
                      Edit
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {modalDensity && (
        <PlantDensityFormModal
          densityId={modalDensity === "new" ? null : modalDensity}
          type={type}
          onClose={() => setModalDensity(null)}
          onSaved={() => {
            setModalDensity(null);
            load();
          }}
        />
      )}
    </div>
  );
}

export function DensityTab() {
  return (
    <section className="setup-section">
      <div className="density-cards-grid">
        <DensityCard type="plants" title="Plants" />
        <DensityCard type="stems" title="Stems" />
      </div>
    </section>
  );
}
