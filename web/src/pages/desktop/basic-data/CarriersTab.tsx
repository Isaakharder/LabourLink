import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../../lib/api";
import { Carrier } from "../../../lib/carrierTypes";
import { useAuth } from "../../../context/AuthContext";
import { CarrierFormModal } from "../../../components/carriers/CarrierFormModal";

type StatusFilter = "active" | "inactive" | "all";

export function CarriersTab() {
  const { employee: currentEmployee } = useAuth();
  const isAdmin = currentEmployee?.securityRole === "Administrator";

  const [carriers, setCarriers] = useState<Carrier[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");

  const [modalCarrier, setModalCarrier] = useState<Carrier | null | "new">(null);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    params.set("status", status);

    api<{ carriers: Carrier[] }>(`/api/carriers?${params.toString()}`)
      .then((res) => {
        setCarriers(res.carriers);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "Could not load carriers");
      });
  }, [search, status]);

  useEffect(() => {
    const t = window.setTimeout(load, search ? 300 : 0);
    return () => window.clearTimeout(t);
  }, [load, search]);

  async function handleToggleActive(carrier: Carrier) {
    if (carrier.isActive) {
      const proceed = window.confirm(
        `Deactivate "${carrier.name}"? It will no longer appear as an option in the mobile Carrier question. Historical time entries are unaffected.`
      );
      if (!proceed) return;
    }
    try {
      await api(`/api/carriers/${carrier.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !carrier.isActive }),
      });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update carrier");
    }
  }

  function renderActions(carrier: Carrier) {
    if (!isAdmin) return null;
    return (
      <div className="employee-row-actions">
        <button type="button" onClick={() => setModalCarrier(carrier)}>
          Edit
        </button>
        <button type="button" onClick={() => handleToggleActive(carrier)}>
          {carrier.isActive ? "Deactivate" : "Activate"}
        </button>
      </div>
    );
  }

  return (
    <section className="setup-section">
      <div className="employees-toolbar">
        <input
          type="search"
          placeholder="Search by carrier name"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="employees-search"
        />

        <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="all">All</option>
        </select>

        <span className="employees-count">
          {carriers ? `${carriers.length} carrier${carriers.length === 1 ? "" : "s"}` : ""}
        </span>

        {isAdmin && (
          <button type="button" className="employees-add-button" onClick={() => setModalCarrier("new")}>
            Add Carrier
          </button>
        )}
      </div>

      {error && <p className="error-text">{error}</p>}

      {!carriers ? (
        <p>Loading...</p>
      ) : carriers.length === 0 ? (
        <p className="placeholder-page">No carriers match these filters.</p>
      ) : (
        <>
          <table className="employees-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Notes</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {carriers.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>{c.notes ?? "—"}</td>
                  <td>
                    <span className={`status-pill ${c.isActive ? "status-active" : "status-inactive"}`}>
                      {c.isActive ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td>{renderActions(c)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="employee-cards">
            {carriers.map((c) => (
              <div className="employee-card" key={c.id}>
                <div className="employee-card-header">
                  <div>
                    <div className="employee-card-name">{c.name}</div>
                    <span className={`status-pill ${c.isActive ? "status-active" : "status-inactive"}`}>
                      {c.isActive ? "Active" : "Inactive"}
                    </span>
                  </div>
                </div>
                <dl className="employee-card-fields">
                  <div>
                    <dt>Notes</dt>
                    <dd>{c.notes ?? "—"}</dd>
                  </div>
                </dl>
                {renderActions(c)}
              </div>
            ))}
          </div>
        </>
      )}

      {modalCarrier && (
        <CarrierFormModal
          carrier={modalCarrier === "new" ? null : modalCarrier}
          onClose={() => setModalCarrier(null)}
          onSaved={() => {
            setModalCarrier(null);
            load();
          }}
        />
      )}
    </section>
  );
}
