// Placeholder session info until device pairing (Phase 3) provides real data.
const MOCK_SESSION = {
  employeeName: "Not yet paired",
  deviceName: "This device",
  syncStatus: "Idle",
};

export function HomeScreen() {
  return (
    <div className="mobile-home">
      <h1>{MOCK_SESSION.employeeName}</h1>
      <p className="device-name">{MOCK_SESSION.deviceName}</p>
      <div className="sync-status">
        <span className="sync-dot" />
        {MOCK_SESSION.syncStatus}
      </div>
    </div>
  );
}
